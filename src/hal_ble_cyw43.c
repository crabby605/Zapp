#include "hal_radio.h"
#include "hal.h"

#include <stdio.h>
#include <string.h>

#include "btstack.h"
#include "ble/gatt-service/nordic_spp_service_server.h"
#include "pico/cyw43_arch.h"
#include "pico/stdlib.h"
#include "zapp_ble.h"          // generated from src/zapp_ble.gatt at build time

// BLE peripheral for the Pico W / Pico 2 W
// One Nordic UART service: the board notifies text to a phone and receives text
// back. Works with nRF Connect, LightBlue and Bluefruit Connect out of the box.
//
// btstack runs on the CYW43 async context (core 0, background IRQ) while the VM
// runs on core 1, so every call in here takes the async-context lock first.
//
// ponytail: one connection, one pending inbound message. A queue and multiple
// centrals would need a ring buffer per connection.

#define BLE_MESSAGE_MAX 64
#define NOTIFY_RETRIES  50     // ~100ms of waiting for a free ATT buffer

static bool ble_started = false;
static hci_con_handle_t connection = HCI_CON_HANDLE_INVALID;
static btstack_packet_callback_registration_t hci_callback;

static char inbox[BLE_MESSAGE_MAX];
static volatile bool inbox_full = false;

// Advertising payload: flags + complete local name (31 bytes max).
static uint8_t adv_data[31];
static uint8_t adv_data_len = 0;

static void ble_lock(void)   { async_context_acquire_lock_blocking(cyw43_arch_async_context()); }
static void ble_unlock(void) { async_context_release_lock(cyw43_arch_async_context()); }

// btstack callbacks

static void hci_packet_handler(uint8_t packet_type, uint16_t channel,
                               uint8_t *packet, uint16_t size) {
    (void)channel; (void)size;
    if (packet_type != HCI_EVENT_PACKET) return;

    switch (hci_event_packet_get_type(packet)) {
        case HCI_EVENT_DISCONNECTION_COMPLETE:
            connection = HCI_CON_HANDLE_INVALID;
            gap_advertisements_enable(1);   // become discoverable again
            break;
        case HCI_EVENT_LE_META:
            if (hci_event_le_meta_get_subevent_code(packet) == HCI_SUBEVENT_LE_CONNECTION_COMPLETE) {
                connection = hci_subevent_le_connection_complete_get_connection_handle(packet);
            }
            break;
        default:
            break;
    }
}

// Data written by the phone arrives here as an RFCOMM-style data packet.
static void spp_packet_handler(uint8_t packet_type, uint16_t channel,
                               uint8_t *packet, uint16_t size) {
    if (packet_type == RFCOMM_DATA_PACKET) {
        uint16_t len = size < BLE_MESSAGE_MAX - 1 ? size : BLE_MESSAGE_MAX - 1;
        memcpy(inbox, packet, len);
        inbox[len] = '\0';
        inbox_full = true;
        return;
    }
    if (packet_type != HCI_EVENT_PACKET) return;
    if (hci_event_packet_get_type(packet) != HCI_EVENT_GATTSERVICE_META) return;

    switch (hci_event_gattservice_meta_get_subevent_code(packet)) {
        case GATTSERVICE_SUBEVENT_SPP_SERVICE_CONNECTED:
            connection = (hci_con_handle_t)channel;
            break;
        case GATTSERVICE_SUBEVENT_SPP_SERVICE_DISCONNECTED:
            connection = HCI_CON_HANDLE_INVALID;
            break;
        default:
            break;
    }
}

// Public API

bool hal_ble_available(void) {
    return true;
}

static void build_adv_data(const char *name) {
    size_t name_len = strlen(name);
    if (name_len > 26) name_len = 26;   // 31 - 3 flag bytes - 2 header bytes

    adv_data_len = 0;
    adv_data[adv_data_len++] = 0x02;    // length
    adv_data[adv_data_len++] = BLUETOOTH_DATA_TYPE_FLAGS;
    adv_data[adv_data_len++] = 0x06;    // LE General Discoverable, BR/EDR not supported
    adv_data[adv_data_len++] = (uint8_t)(name_len + 1);
    adv_data[adv_data_len++] = BLUETOOTH_DATA_TYPE_COMPLETE_LOCAL_NAME;
    memcpy(&adv_data[adv_data_len], name, name_len);
    adv_data_len = (uint8_t)(adv_data_len + name_len);
}

bool hal_ble_advertise(const char *name) {
    ble_lock();

    if (!ble_started) {
        // cyw43_arch_init() may already have been called by the Wi-Fi side;
        // it is safe to call once and the driver tracks its own state.
        if (cyw43_arch_init() != 0) {
            ble_unlock();
            hal_debug_println("Radio Error: CYW43 init failed");
            return false;
        }
        l2cap_init();
        sm_init();
        att_server_init(profile_data, NULL, NULL);
        nordic_spp_service_server_init(&spp_packet_handler);

        hci_callback.callback = &hci_packet_handler;
        hci_add_event_handler(&hci_callback);

        hci_power_control(HCI_POWER_ON);
        ble_started = true;
    }

    // gap_set_local_name() is a classic-Bluetooth call and isn't linked in an
    // LE-only build. Scanners show the advertised name, which is dynamic; the
    // GATT device-name characteristic stays "Zapp" (see src/zapp_ble.gatt).
    build_adv_data(name);

    bd_addr_t null_addr;
    memset(null_addr, 0, sizeof(null_addr));
    // 800 * 0.625ms = 500ms between adverts: discoverable without draining power.
    gap_advertisements_set_params(800, 800, 0, 0, null_addr, 0x07, 0x00);
    gap_advertisements_set_data(adv_data_len, adv_data);
    gap_advertisements_enable(1);

    ble_unlock();
    return true;
}

bool hal_ble_connected(void) {
    return ble_started && connection != HCI_CON_HANDLE_INVALID;
}

bool hal_ble_notify(const char *text) {
    if (!hal_ble_connected()) return false;

    uint16_t len = (uint16_t)strlen(text);
    for (int attempt = 0; attempt < NOTIFY_RETRIES; attempt++) {
        ble_lock();
        int err = nordic_spp_service_server_send(connection, (const uint8_t *)text, len);
        ble_unlock();
        if (err == ERROR_CODE_SUCCESS) return true;
        sleep_ms(2);   // ATT buffer busy — the stack drains it in the background
    }
    hal_debug_println("Bluetooth Error: notify buffer stayed full");
    return false;
}

bool hal_ble_message(char *out, size_t out_len) {
    if (!inbox_full) {
        if (out_len) out[0] = '\0';
        return false;
    }
    ble_lock();
    snprintf(out, out_len, "%s", inbox);
    inbox_full = false;
    ble_unlock();
    return true;
}
