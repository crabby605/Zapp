#include "port.h"
#include "config.h"
#include "project_store.h"
#include "repl.h"

#include <stdio.h>
#include <stdlib.h>

#include "hardware/clocks.h"
#include "hardware/flash.h"
#include "hardware/watchdog.h"
#include "pico/bootrom.h"
#include "pico/flash.h"
#include "pico/multicore.h"
#include "pico/stdlib.h"
#include "pico/unique_id.h"

// The project store sits in the last ZAPP_STORE_KB of flash.
#define STORE_BYTES (ZAPP_STORE_KB * 1024u)
#define STORE_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - STORE_BYTES)

static void (*vm_entry)(void);

// Core 1 takes part in flash_safe_execute's lockout before it runs the VM.
// The SIO FIFO belongs to that lockout, so the VM is woken with __sev, never
// with FIFO traffic (see pico/multicore.h).
static void core1_trampoline(void) {
    flash_safe_execute_core_init();
    vm_entry();
}

void port_init(void) {
    set_sys_clock_khz(ZAPP_CLOCK_MHZ * 1000, true);
    flash_safe_execute_core_init();
}

void port_idle(void) {}

void port_vm_launch(void (*entry)(void)) {
    vm_entry = entry;
    multicore_launch_core1(core1_trampoline);
}

void port_vm_relaunch(void (*entry)(void)) {
    multicore_reset_core1();
    port_vm_launch(entry);
}

void port_vm_wait(void) { __wfe(); }
void port_vm_wake(void) { __sev(); }

void port_reboot(void) { watchdog_reboot(0, 0, 100); }
void port_bootloader(void) { reset_usb_boot(0, 0); }

void port_serial_number(char *out, size_t len) {
    pico_get_unique_board_id_string(out, len);
}

size_t port_store_size(void) { return STORE_BYTES; }
size_t port_disk_blocks(void) { return ZAPP_DISK_KB * 2; }
void *port_alloc_big(size_t bytes) { return malloc(bytes); }

const uint8_t *port_store_flash(void) {
    return (const uint8_t *)(XIP_BASE + STORE_FLASH_OFFSET);
}

typedef struct {
    const uint8_t *src;
    uint32_t flash_offset;
} SectorWrite;

static void write_sector(void *param) {
    SectorWrite *w = param;
    flash_range_erase(w->flash_offset, FLASH_SECTOR_SIZE);
    flash_range_program(w->flash_offset, w->src, FLASH_SECTOR_SIZE);
}

bool port_store_write_sector(size_t offset, const uint8_t *src) {
    SectorWrite w = { .src = src, .flash_offset = STORE_FLASH_OFFSET + (uint32_t)offset };
    return flash_safe_execute(write_sector, &w, UINT32_MAX) == PICO_OK;
}

int main(void) {
    zapp_main();
}
