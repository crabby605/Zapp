#include "usb_hid.h"

#include <string.h>

#include "pico/stdlib.h"
#include "tusb.h"

// Keystrokes are paced by the host's HID polling interval (10ms in the
// descriptor). Between reports we pump TinyUSB so the report actually leaves.
#define HID_REPORT_TIMEOUT_MS 50

bool usb_hid_ready(void) {
    return tud_mounted() && tud_hid_ready();
}

// Wait until the HID endpoint can take another report, pumping USB meanwhile.
static bool hid_wait_ready(void) {
    uint64_t deadline = time_us_64() + HID_REPORT_TIMEOUT_MS * 1000;
    while (!tud_hid_ready()) {
        if (!tud_mounted() || time_us_64() > deadline) return false;
        tud_task();
    }
    return true;
}

void usb_hid_key(uint8_t modifier, uint8_t keycode) {
    if (!tud_mounted()) return;

    uint8_t keys[6] = { keycode, 0, 0, 0, 0, 0 };
    if (!hid_wait_ready()) return;
    tud_hid_keyboard_report(ZAPP_HID_REPORT_KEYBOARD, modifier, keys);

    // Every press needs a matching release or the host repeats the key.
    if (!hid_wait_ready()) return;
    tud_hid_keyboard_report(ZAPP_HID_REPORT_KEYBOARD, 0, NULL);
}

// ASCII → HID usage id. Letters and digits are contiguous in the usage table;
// the rest is a small lookup.
bool usb_hid_ascii_to_keycode(char c, uint8_t *keycode, uint8_t *modifier) {
    *modifier = 0;

    if (c >= 'a' && c <= 'z') { *keycode = (uint8_t)(HID_KEY_A + (c - 'a')); return true; }
    if (c >= 'A' && c <= 'Z') {
        *keycode = (uint8_t)(HID_KEY_A + (c - 'A'));
        *modifier = ZAPP_HID_SHIFT;
        return true;
    }
    if (c >= '1' && c <= '9') { *keycode = (uint8_t)(HID_KEY_1 + (c - '1')); return true; }
    if (c == '0') { *keycode = HID_KEY_0; return true; }

    // {character, keycode, needs shift}
    static const struct { char c; uint8_t key; bool shift; } punct[] = {
        {' ',  HID_KEY_SPACE,          false}, {'\n', HID_KEY_ENTER,         false},
        {'\t', HID_KEY_TAB,            false}, {'-',  HID_KEY_MINUS,         false},
        {'=',  HID_KEY_EQUAL,          false}, {'[',  HID_KEY_BRACKET_LEFT,  false},
        {']',  HID_KEY_BRACKET_RIGHT,  false}, {'\\', HID_KEY_BACKSLASH,     false},
        {';',  HID_KEY_SEMICOLON,      false}, {'\'', HID_KEY_APOSTROPHE,    false},
        {'`',  HID_KEY_GRAVE,          false}, {',',  HID_KEY_COMMA,         false},
        {'.',  HID_KEY_PERIOD,         false}, {'/',  HID_KEY_SLASH,         false},
        {'!',  HID_KEY_1,              true},  {'@',  HID_KEY_2,             true},
        {'#',  HID_KEY_3,              true},  {'$',  HID_KEY_4,             true},
        {'%',  HID_KEY_5,              true},  {'^',  HID_KEY_6,             true},
        {'&',  HID_KEY_7,              true},  {'*',  HID_KEY_8,             true},
        {'(',  HID_KEY_9,              true},  {')',  HID_KEY_0,             true},
        {'_',  HID_KEY_MINUS,          true},  {'+',  HID_KEY_EQUAL,         true},
        {'{',  HID_KEY_BRACKET_LEFT,   true},  {'}',  HID_KEY_BRACKET_RIGHT, true},
        {'|',  HID_KEY_BACKSLASH,      true},  {':',  HID_KEY_SEMICOLON,     true},
        {'"',  HID_KEY_APOSTROPHE,     true},  {'~',  HID_KEY_GRAVE,         true},
        {'<',  HID_KEY_COMMA,          true},  {'>',  HID_KEY_PERIOD,        true},
        {'?',  HID_KEY_SLASH,          true},
    };

    for (size_t i = 0; i < sizeof(punct) / sizeof(punct[0]); i++) {
        if (punct[i].c == c) {
            *keycode = punct[i].key;
            *modifier = punct[i].shift ? ZAPP_HID_SHIFT : 0;
            return true;
        }
    }
    return false;
}

void usb_hid_type(const char *text) {
    for (const char *c = text; *c; c++) {
        uint8_t keycode, modifier;
        if (usb_hid_ascii_to_keycode(*c, &keycode, &modifier)) {
            usb_hid_key(modifier, keycode);
        }
    }
}

void usb_hid_mouse(int8_t dx, int8_t dy, uint8_t buttons, int8_t scroll) {
    if (!tud_mounted() || !hid_wait_ready()) return;
    tud_hid_mouse_report(ZAPP_HID_REPORT_MOUSE, buttons, dx, dy, scroll, 0);

    // A click needs a button-up report, otherwise the host sees a held button.
    if (buttons != 0 && hid_wait_ready()) {
        tud_hid_mouse_report(ZAPP_HID_REPORT_MOUSE, 0, 0, 0, 0, 0);
    }
}

// TinyUSB callbacks (required whenever HID is enabled)

uint16_t tud_hid_get_report_cb(uint8_t instance, uint8_t report_id,
                               hid_report_type_t report_type,
                               uint8_t *buffer, uint16_t reqlen) {
    (void) instance; (void) report_id; (void) report_type;
    (void) buffer; (void) reqlen;
    return 0;   // this device only sends reports
}

void tud_hid_set_report_cb(uint8_t instance, uint8_t report_id,
                           hid_report_type_t report_type,
                           uint8_t const *buffer, uint16_t bufsize) {
    (void) instance; (void) report_id; (void) report_type;
    (void) buffer; (void) bufsize;   // ignore host LED state (caps lock etc.)
}
