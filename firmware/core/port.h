#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// What the shared firmware needs from a chip, beyond the hal_* hardware calls.
// Each port (firmware/rp2040, firmware/esp32s3) implements these once.

// Clocks, flash access and the USB PHY: everything before usb_device_init.
void port_init(void);

// Called once per main-loop pass, so an RTOS can run its other tasks.
void port_idle(void);

// The VM runs `entry` on the second core. port_vm_wait parks that core until
// the main loop calls port_vm_wake.
void port_vm_launch(void (*entry)(void));
void port_vm_relaunch(void (*entry)(void));   // reset a stuck VM core, start again
void port_vm_wait(void);
void port_vm_wake(void);

void port_reboot(void);
void port_bootloader(void);                   // reboot into the chip's flashing mode

// Unique per chip, so two boards don't share a COM port or drive.
void port_serial_number(char *out, size_t len);

// Storage, sized to this board when it starts: boards with PSRAM get far more.
// port_store_size: bytes of flash for the project store (a multiple of
// PORT_STORE_SECTOR), mirrored in RAM. port_disk_blocks: the USB drive's size in
// 512-byte blocks, held in RAM. port_alloc_big: memory for both — PSRAM when the
// board has it; never freed.
size_t port_store_size(void);
size_t port_disk_blocks(void);
void *port_alloc_big(size_t bytes);

// The project store's flash region: memory-mapped for reading, written one
// PORT_STORE_SECTOR-byte sector at a time.
#define PORT_STORE_SECTOR 4096
const uint8_t *port_store_flash(void);
bool port_store_write_sector(size_t offset, const uint8_t *src);
