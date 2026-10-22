#pragma once

#include <stdbool.h>
#include <stdint.h>

// Zapp USB device library
// One composite device: CDC serial (REPL + debug), MSC drive (main.zap),
// and HID (keyboard + mouse). Everything USB goes through here so the rest of
// the firmware never touches TinyUSB directly.

void usb_device_init(void);      // descriptors + MSC disk + tusb_init
void usb_device_task(void);      // pump the stack — call from the main loop
bool usb_device_mounted(void);

// CDC serial
void usb_cdc_write(const char *s);        // blocking-ish, drains a full FIFO
void usb_cdc_writeln(const char *s);
void usb_cdc_write_char(char c);
void usb_cdc_flush(void);
bool usb_cdc_available(void);
int  usb_cdc_read_char(void);             // -1 when nothing is buffered
