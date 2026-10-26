#include "port.h"
#include "config.h"
#include "project_store.h"
#include "repl.h"

#include <stdio.h>
#include <stdlib.h>

#include "esp_heap_caps.h"
#include "esp_mac.h"
#include "esp_partition.h"
#include "esp_private/usb_phy.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "soc/rtc_cntl_reg.h"

// The VM gets core 1 to itself; USB, the REPL, Wi-Fi and BLE live on core 0.
// 16KB because HTTPS requests run their TLS handshake on the VM's stack.
#define VM_STACK_BYTES (16 * 1024)
#define VM_PRIORITY    5

static TaskHandle_t vm_task;
static void (*vm_entry)(void);
static usb_phy_handle_t usb_phy;

static const esp_partition_t *store;
static const uint8_t *store_map;
static size_t store_bytes;

// PSRAM the board actually has, measured (0 without it, or in a build without
// PSRAM support). Its type — quad or octal — can't be measured: the chip must
// already be talking to it in the right mode, so that's set per board build.
static size_t psram_bytes(void) {
    return heap_caps_get_total_size(MALLOC_CAP_SPIRAM);
}

// With PSRAM: the drive gets half of it, up to FAT12's limit with 512-byte
// clusters (just under 2MB); the store a quarter, up to its flash partition.
#define DISK_MAX_BLOCKS 4000

static void vm_task_main(void *arg) {
    (void)arg;
    vm_entry();
}

// Our partition table has a "zapp" partition. A board flashed by UF2 keeps
// its bootloader's table instead, so fall back to the start of its FAT
// partition (Adafruit's TinyUF2 layout has one).
static void store_open(void) {
    store = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, 0x40, "zapp");
    if (!store) store = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_FAT, NULL);
    size_t want = psram_bytes() ? psram_bytes() / 4 : ZAPP_STORE_KB * 1024u;
    if (!store || store->size < ZAPP_STORE_KB * 1024u) {
        printf("Zapp: no flash partition for the project store\n");
        abort();
    }
    store_bytes = want < store->size ? want : store->size;
    store_bytes -= store_bytes % PORT_STORE_SECTOR;
    esp_partition_mmap_handle_t handle;
    ESP_ERROR_CHECK(esp_partition_mmap(store, 0, store_bytes,
                                       ESP_PARTITION_MMAP_DATA, (const void **)&store_map, &handle));
}

void port_init(void) {
    store_open();
    usb_phy_config_t phy = {
        .controller = USB_PHY_CTRL_OTG,
        .target = USB_PHY_TARGET_INT,
        .otg_mode = USB_OTG_MODE_DEVICE,
    };
    ESP_ERROR_CHECK(usb_new_phy(&phy, &usb_phy));
}

void port_idle(void) {
    vTaskDelay(1);   // let core 0's lower-priority tasks (and its idle task) run
}

void port_vm_launch(void (*entry)(void)) {
    vm_entry = entry;
    xTaskCreatePinnedToCore(vm_task_main, "zapp_vm", VM_STACK_BYTES, NULL,
                            VM_PRIORITY, &vm_task, 1);
}

// ponytail: deleting the task can leave a driver lock it held taken, so a
// stuck I2C or SPI call may need a reset afterwards. Same trade as resetting
// core 1 on the RP2040.
void port_vm_relaunch(void (*entry)(void)) {
    vTaskDelete(vm_task);
    port_vm_launch(entry);
}

void port_vm_wait(void) { ulTaskNotifyTake(pdTRUE, portMAX_DELAY); }
void port_vm_wake(void) { xTaskNotifyGive(vm_task); }

void port_reboot(void) { esp_restart(); }

// Hand the USB pins back to the built-in serial/JTAG port, then reboot into
// the ROM's download mode, where idf.py / esptool can flash it.
void port_bootloader(void) {
    usb_del_phy(usb_phy);
    usb_phy_config_t phy = {
        .controller = USB_PHY_CTRL_SERIAL_JTAG,
        .target = USB_PHY_TARGET_INT,
    };
    usb_new_phy(&phy, &usb_phy);
    REG_WRITE(RTC_CNTL_OPTION1_REG, RTC_CNTL_FORCE_DOWNLOAD_BOOT);
    esp_restart();
}

void port_serial_number(char *out, size_t len) {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(out, len, "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

size_t port_store_size(void) { return store_bytes; }
size_t port_disk_blocks(void) {
    if (!psram_bytes()) return ZAPP_DISK_KB * 2u;
    size_t blocks = psram_bytes() / 2 / 512;
    return blocks < DISK_MAX_BLOCKS ? blocks : DISK_MAX_BLOCKS;
}

void *port_alloc_big(size_t bytes) {
    void *p = psram_bytes() ? heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) : NULL;
    return p ? p : heap_caps_malloc(bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

const uint8_t *port_store_flash(void) {
    return store_map;
}

bool port_store_write_sector(size_t offset, const uint8_t *src) {
    return esp_partition_erase_range(store, offset, PORT_STORE_SECTOR) == ESP_OK &&
           esp_partition_write(store, offset, src, PORT_STORE_SECTOR) == ESP_OK;
}

void app_main(void) {
    zapp_main();
}
