#include "hal_radio.h"
#include "hal.h"
#include "project_store.h"

#include <stdio.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_http_server.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "nvs_flash.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

// Wi-Fi, HTTP and BLE for the ESP32-S3. 2.4GHz only, like every S3.
// ESP-IDF brings its own DHCP server for the access point and does HTTPS with
// its certificate bundle, so this port has neither limit the Pico W has.

#define HTTP_TIMEOUT_MS 15000

#define GOT_IP BIT0

static bool radio_started = false;
static bool want_sta = false;
static bool ap_up = false;
static esp_netif_t *sta_netif;
static esp_netif_t *ap_netif;
static EventGroupHandle_t wifi_events;

// Wi-Fi calibration data and BLE bonding keys live in NVS.
static bool nvs_ready(void) {
    static bool ready = false;
    if (ready) return true;
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    ready = (err == ESP_OK);
    return ready;
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg; (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(wifi_events, GOT_IP);
        if (want_sta) esp_wifi_connect();   // keep trying, like a phone does
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(wifi_events, GOT_IP);
    }
}

static bool radio_start(void) {
    if (radio_started) return true;
    if (!nvs_ready()) {
        hal_debug_println("Radio Error: could not open NVS");
        return false;
    }
    esp_netif_init();
    esp_event_loop_create_default();
    sta_netif = esp_netif_create_default_wifi_sta();
    wifi_events = xEventGroupCreate();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    if (esp_wifi_init(&cfg) != ESP_OK) {
        hal_debug_println("Radio Error: Wi-Fi init failed");
        return false;
    }
    esp_wifi_set_storage(WIFI_STORAGE_RAM);   // programs say the network; don't remember it
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi_event, NULL);
    esp_wifi_set_mode(WIFI_MODE_STA);
    esp_wifi_start();
    radio_started = true;
    return true;
}

bool hal_radio_available(void) {
    return true;
}

// The S3 boards' LEDs are ordinary GPIOs (or NeoPixels), not radio pins.
bool hal_radio_led(bool on) {
    (void)on;
    return false;
}

bool hal_wifi_connect(const char *ssid, const char *password, uint32_t timeout_ms) {
    if (!radio_start()) return false;

    wifi_config_t c = { 0 };
    strncpy((char *)c.sta.ssid, ssid, sizeof(c.sta.ssid));
    strncpy((char *)c.sta.password, password, sizeof(c.sta.password));
    c.sta.threshold.authmode = password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;

    want_sta = false;
    esp_wifi_disconnect();
    xEventGroupClearBits(wifi_events, GOT_IP);
    esp_wifi_set_config(WIFI_IF_STA, &c);
    want_sta = true;
    esp_wifi_connect();

    EventBits_t bits = xEventGroupWaitBits(wifi_events, GOT_IP, pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(timeout_ms));
    if (!(bits & GOT_IP)) {
        char msg[64];
        snprintf(msg, sizeof(msg), "Radio Error: could not join '%s'", ssid);
        hal_debug_println(msg);
        return false;
    }
    return true;
}

bool hal_wifi_connected(void) {
    return radio_started && (xEventGroupGetBits(wifi_events) & GOT_IP);
}

void hal_wifi_ip(char *out, size_t out_len) {
    esp_netif_ip_info_t info = { 0 };
    if (ap_up) esp_netif_get_ip_info(ap_netif, &info);
    else if (hal_wifi_connected()) esp_netif_get_ip_info(sta_netif, &info);
    snprintf(out, out_len, IPSTR, IP2STR(&info.ip));
}

bool hal_wifi_start_ap(const char *ssid, const char *password) {
    if (!radio_start()) return false;
    if (!ap_netif) ap_netif = esp_netif_create_default_wifi_ap();   // 192.168.4.1, DHCP on

    wifi_config_t c = { 0 };
    strncpy((char *)c.ap.ssid, ssid, sizeof(c.ap.ssid));
    c.ap.ssid_len = (uint8_t)strlen(ssid);
    strncpy((char *)c.ap.password, password, sizeof(c.ap.password));
    c.ap.authmode = password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    c.ap.channel = 1;   // follows the joined network's channel if there is one
    c.ap.max_connection = 8;

    if (esp_wifi_set_mode(WIFI_MODE_APSTA) != ESP_OK ||
        esp_wifi_set_config(WIFI_IF_AP, &c) != ESP_OK) {
        hal_debug_println("Radio Error: could not start the access point");
        return false;
    }
    ap_up = true;
    return true;
}

// HTTP(S) client. One request at a time, on the VM's task.

int hal_http_request(const char *method, const char *url,
                     const char *body, char *out, size_t out_len) {
    if (out_len) out[0] = '\0';
    if (!hal_wifi_connected()) {
        hal_debug_println("Network Error: not connected to wifi");
        return 0;
    }

    esp_http_client_config_t c = {
        .url = url,
        .method = strcmp(method, "POST") == 0 ? HTTP_METHOD_POST : HTTP_METHOD_GET,
        .timeout_ms = HTTP_TIMEOUT_MS,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t h = esp_http_client_init(&c);
    if (!h) {
        hal_debug_println("Network Error: bad url");
        return 0;
    }

    int body_len = body ? (int)strlen(body) : 0;
    if (body) esp_http_client_set_header(h, "Content-Type", "application/x-www-form-urlencoded");

    int status = 0;
    if (esp_http_client_open(h, body_len) == ESP_OK &&
        (body_len == 0 || esp_http_client_write(h, body, body_len) == body_len) &&
        esp_http_client_fetch_headers(h) >= 0) {
        status = esp_http_client_get_status_code(h);
        int n = out_len ? esp_http_client_read_response(h, out, (int)out_len - 1) : 0;
        if (out_len) out[n > 0 ? n : 0] = '\0';
    } else {
        hal_debug_println("Network Error: request failed to connect");
    }
    esp_http_client_close(h);
    esp_http_client_cleanup(h);
    return status;
}

// Web server: answers GET with a file from the drive's web/ folder, sent
// straight from the store (no copy, so any size the store holds).
//
// ponytail: reads the store without locking against a drive sync on the other
// core; a page saved mid-request can come out mixed. Copy-on-serve if that bites.

static httpd_handle_t web;

static esp_err_t web_get(httpd_req_t *req) {
    char name[PROJECT_STORE_NAME_MAX];
    size_t len = 0;
    const uint8_t *body = web_file_name(req->uri + 1, name, sizeof(name))
                        ? project_store_module_data(name, &len) : NULL;
    if (!body) {
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Not found");
    }
    httpd_resp_set_type(req, web_content_type(name));
    return httpd_resp_send(req, (const char *)body, (ssize_t)len);
}

bool hal_web_serve(void) {
    if (web) return true;
    if (!radio_start()) return false;

    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    httpd_uri_t any = { .uri = "/*", .method = HTTP_GET, .handler = web_get };
    if (httpd_start(&web, &cfg) != ESP_OK || httpd_register_uri_handler(web, &any) != ESP_OK) {
        web = NULL;
        hal_debug_println("Network Error: could not listen on port 80");
        return false;
    }
    return true;
}

void hal_radio_poll(void) {
    // ESP-IDF runs Wi-Fi and lwIP in their own tasks.
}

// BLE peripheral: one Nordic UART service, so nRF Connect, LightBlue and
// Bluefruit Connect can read notifications and send text back.
//
// ponytail: one connection, one pending inbound message, same as the Pico W.

#define BLE_MESSAGE_MAX 64
#define NOTIFY_RETRIES  50     // ~100ms of waiting for a free buffer

static const ble_uuid128_t nus_service = BLE_UUID128_INIT(
    0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0, 0x93, 0xf3, 0xa3, 0xb5, 0x01, 0x00, 0x40, 0x6e);
static const ble_uuid128_t nus_rx = BLE_UUID128_INIT(   // phone writes here
    0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0, 0x93, 0xf3, 0xa3, 0xb5, 0x02, 0x00, 0x40, 0x6e);
static const ble_uuid128_t nus_tx = BLE_UUID128_INIT(   // board notifies here
    0x9e, 0xca, 0xdc, 0x24, 0x0e, 0xe5, 0xa9, 0xe0, 0x93, 0xf3, 0xa3, 0xb5, 0x03, 0x00, 0x40, 0x6e);

static bool ble_started = false;
static volatile bool ble_synced = false;
static volatile uint16_t connection = BLE_HS_CONN_HANDLE_NONE;
static volatile bool ble_wanted = false;   // advertise again after a disconnect
static uint16_t tx_handle;
static uint8_t own_addr_type;
static char adv_name[32];

static char inbox[BLE_MESSAGE_MAX];
static volatile bool inbox_full = false;

static int nus_access(uint16_t conn, uint16_t attr, struct ble_gatt_access_ctxt *ctxt, void *arg) {
    (void)conn; (void)attr; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return BLE_ATT_ERR_UNLIKELY;
    uint16_t len = 0;
    ble_hs_mbuf_to_flat(ctxt->om, inbox, sizeof(inbox) - 1, &len);   // longer messages are cut
    inbox[len] = '\0';
    inbox_full = true;
    return 0;
}

static const struct ble_gatt_svc_def gatt_services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &nus_service.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            { .uuid = &nus_tx.u, .access_cb = nus_access, .val_handle = &tx_handle,
              .flags = BLE_GATT_CHR_F_NOTIFY },
            { .uuid = &nus_rx.u, .access_cb = nus_access,
              .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP },
            { 0 },
        },
    },
    { 0 },
};

static int gap_event(struct ble_gap_event *event, void *arg);

static void advertise(void) {
    if (!ble_wanted) return;
    struct ble_hs_adv_fields fields = { 0 };
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (uint8_t *)adv_name;
    fields.name_len = (uint8_t)strlen(adv_name);
    fields.name_is_complete = 1;
    ble_gap_adv_set_fields(&fields);

    struct ble_gap_adv_params params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
    };
    ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
}

static int gap_event(struct ble_gap_event *event, void *arg) {
    (void)arg;
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) connection = event->connect.conn_handle;
            else advertise();
            break;
        case BLE_GAP_EVENT_DISCONNECT:
            connection = BLE_HS_CONN_HANDLE_NONE;
            advertise();   // become discoverable again
            break;
        case BLE_GAP_EVENT_ADV_COMPLETE:
            advertise();
            break;
        default:
            break;
    }
    return 0;
}

static void on_sync(void) {
    ble_hs_util_ensure_addr(0);
    ble_hs_id_infer_auto(0, &own_addr_type);
    ble_synced = true;
    advertise();
}

static void ble_host_task(void *param) {
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

bool hal_ble_available(void) {
    return true;
}

bool hal_ble_advertise(const char *name) {
    snprintf(adv_name, sizeof(adv_name), "%s", name);
    ble_wanted = true;
    if (ble_started) {
        if (ble_synced && connection == BLE_HS_CONN_HANDLE_NONE) {
            ble_gap_adv_stop();
            advertise();
        }
        return true;
    }

    if (!nvs_ready() || nimble_port_init() != ESP_OK) {
        hal_debug_println("Radio Error: Bluetooth init failed");
        return false;
    }
    ble_hs_cfg.sync_cb = on_sync;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_gap_device_name_set("Zapp");
    if (ble_gatts_count_cfg(gatt_services) != 0 || ble_gatts_add_svcs(gatt_services) != 0) {
        hal_debug_println("Radio Error: Bluetooth service setup failed");
        return false;
    }
    nimble_port_freertos_init(ble_host_task);
    ble_started = true;
    return true;
}

bool hal_ble_connected(void) {
    return connection != BLE_HS_CONN_HANDLE_NONE;
}

bool hal_ble_notify(const char *text) {
    for (int i = 0; i < NOTIFY_RETRIES; i++) {
        if (connection == BLE_HS_CONN_HANDLE_NONE) return false;
        struct os_mbuf *om = ble_hs_mbuf_from_flat(text, (uint16_t)strlen(text));
        if (om && ble_gatts_notify_custom(connection, tx_handle, om) == 0) return true;
        vTaskDelay(pdMS_TO_TICKS(2));   // out of buffers: let the stack send some
    }
    return false;
}

bool hal_ble_message(char *out, size_t out_len) {
    if (!inbox_full) {
        if (out_len) out[0] = '\0';
        return false;
    }
    snprintf(out, out_len, "%s", inbox);
    inbox_full = false;   // each message is delivered once
    return true;
}

void hal_radio_reset(void) {
    if (ble_started && ble_synced) {
        ble_wanted = false;
        ble_gap_adv_stop();
        if (connection != BLE_HS_CONN_HANDLE_NONE) ble_gap_terminate(connection, BLE_ERR_REM_USER_CONN_TERM);
    }
    if (web) { httpd_stop(web); web = NULL; }
    if (!radio_started) return;
    want_sta = false;   // don't rejoin when the disconnect event comes in
    esp_wifi_disconnect();
    xEventGroupClearBits(wifi_events, GOT_IP);
    if (ap_up) { esp_wifi_set_mode(WIFI_MODE_STA); ap_up = false; }
}
