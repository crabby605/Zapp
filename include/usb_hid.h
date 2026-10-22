#pragma once

#include <stdbool.h>
#include <stdint.h>

// Zapp HID library
// The board acts as a USB keyboard and mouse on the host it's plugged into.
// Reports are queued from the VM (core 1) and sent from the USB loop (core 0),
// because TinyUSB is single-threaded — see hal_hid_* in hal.h.

#define ZAPP_HID_REPORT_KEYBOARD 1
#define ZAPP_HID_REPORT_MOUSE    2

// Modifier bits, matching the HID spec (combine with |).
#define ZAPP_HID_CTRL   0x01
#define ZAPP_HID_SHIFT  0x02
#define ZAPP_HID_ALT    0x04
#define ZAPP_HID_GUI    0x08

// Mouse button bits.
#define ZAPP_HID_MOUSE_LEFT   0x01
#define ZAPP_HID_MOUSE_RIGHT  0x02
#define ZAPP_HID_MOUSE_MIDDLE 0x04

bool usb_hid_ready(void);

// Press and release one key. `keycode` is a HID usage id (0 = modifiers only).
void usb_hid_key(uint8_t modifier, uint8_t keycode);

// Type printable ASCII, one keystroke per character.
void usb_hid_type(const char *text);

void usb_hid_mouse(int8_t dx, int8_t dy, uint8_t buttons, int8_t scroll);

// Map one ASCII character to a HID keycode + modifier. False if unprintable.
bool usb_hid_ascii_to_keycode(char c, uint8_t *keycode, uint8_t *modifier);
