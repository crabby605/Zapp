#include "hal.h"
#include "hal_radio.h"
#include "uart_ring.h"
#include "usb_hid.h"

#include <stdio.h>
#include <string.h>

// The chip-independent half of the HAL: the VM core queues HID reports and
// debug text, the USB core sends them.

// HID queue (VM core → USB core)
// Frames: [0xE0 mod key] | [0xE1 len text...] | [0xE2 dx dy buttons scroll]

#define HID_FRAME_KEY   0xE0
#define HID_FRAME_TYPE  0xE1
#define HID_FRAME_MOUSE 0xE2

static UartRing hid_queue;
static bool hid_queue_started = false;

// Push to a core-0-drained ring, waiting (up to ~1s) for room instead of
// dropping bytes: a dropped byte mangles output or tears a HID frame.
static void ring_push_wait(UartRing *r, uint8_t b) {
    for (int spins = 0; !uart_ring_push(r, b); spins++) {
        if (spins > 100000) return;   // core 0 isn't draining — give up
        hal_sleep_us(10);
    }
}

static void hid_queue_push(const uint8_t *frame, uint8_t len) {
    if (!hid_queue_started) {
        uart_ring_init(&hid_queue);
        hid_queue_started = true;
    }
    for (uint8_t i = 0; i < len; i++) {
        ring_push_wait(&hid_queue, frame[i]);
    }
}

void hal_hid_key(uint8_t modifier, uint8_t keycode) {
    uint8_t frame[3] = { HID_FRAME_KEY, modifier, keycode };
    hid_queue_push(frame, 3);
}

void hal_hid_type(const char *text, uint8_t len) {
    uint8_t header[2] = { HID_FRAME_TYPE, len };
    hid_queue_push(header, 2);
    hid_queue_push((const uint8_t *)text, len);
}

void hal_hid_mouse(int8_t dx, int8_t dy, uint8_t buttons, int8_t scroll) {
    uint8_t frame[5] = { HID_FRAME_MOUSE, (uint8_t)dx, (uint8_t)dy, buttons, (uint8_t)scroll };
    hid_queue_push(frame, 5);
}

// Wait for the producer core to finish writing the rest of a frame.
static bool hid_take(uint8_t *out, uint8_t count) {
    for (uint8_t i = 0; i < count; i++) {
        int spins = 0;
        while (!uart_ring_pop(&hid_queue, &out[i])) {
            if (++spins > 1000) return false;   // torn frame — drop it
            hal_sleep_us(1);
        }
    }
    return true;
}

void hal_hid_pump(void) {
    if (!hid_queue_started) return;

    uint8_t op;
    while (uart_ring_pop(&hid_queue, &op)) {
        if (op == HID_FRAME_KEY) {
            uint8_t args[2];
            if (hid_take(args, 2)) usb_hid_key(args[0], args[1]);
        } else if (op == HID_FRAME_MOUSE) {
            uint8_t args[4];
            if (hid_take(args, 4)) {
                usb_hid_mouse((int8_t)args[0], (int8_t)args[1], args[2], (int8_t)args[3]);
            }
        } else if (op == HID_FRAME_TYPE) {
            uint8_t len;
            if (!hid_take(&len, 1)) return;
            // Type in chunks: every byte of the frame must be consumed, or the
            // leftover text gets parsed as the next frame.
            char text[65];
            while (len > 0) {
                uint8_t n = (len > sizeof(text) - 1) ? (uint8_t)(sizeof(text) - 1) : len;
                if (!hid_take((uint8_t *)text, n)) return;
                text[n] = '\0';
                usb_hid_type(text);
                len -= n;
            }
        }
    }
}

void hal_debug_print(const char *s) {
    while (*s) {
        ring_push_wait(&uart_ring_debug, (uint8_t)*s++);
    }
}

void hal_debug_println(const char *s) {
    hal_debug_print(s);
    hal_debug_print("\r\n");
}

// Web files live in the store as "web/<name>".

bool web_file_name(const char *path, char *name, size_t name_len) {
    size_t n = strcspn(path, " ?#\r\n");
    if (n == 0) {
        path = "index.html";
        n = strlen(path);
    }
    if (n + 4 >= name_len) return false;
    snprintf(name, name_len, "web/%.*s", (int)n, path);
    return true;
}

const char *web_content_type(const char *name) {
    const char *dot = strrchr(name, '.');
    if (!dot) return "text/plain";
    if (strcmp(dot, ".html") == 0 || strcmp(dot, ".htm") == 0) return "text/html";
    if (strcmp(dot, ".css") == 0)  return "text/css";
    if (strcmp(dot, ".js") == 0)   return "application/javascript";
    if (strcmp(dot, ".json") == 0) return "application/json";
    if (strcmp(dot, ".svg") == 0)  return "image/svg+xml";
    return "text/plain";
}
