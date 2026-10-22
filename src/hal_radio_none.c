#include "hal_radio.h"
#include "hal.h"

#include <string.h>

// Radio HAL for boards that have no radio — the plain RP2040 (Pico, XIAO
// RP2040, Feather RP2040). Every call fails loudly rather than silently doing
// nothing, so a program that expects WiFi says why it stopped.
//
// Build the Pico W instead with: cmake -DZAPP_BOARD=pico_w

bool hal_radio_available(void) {
    return false;
}

bool hal_radio_led(bool on) {
    (void)on;
    return false;
}

bool hal_wifi_connect(const char *ssid, const char *password, uint32_t timeout_ms) {
    (void)ssid; (void)password; (void)timeout_ms;
    return false;
}

bool hal_wifi_start_ap(const char *ssid, const char *password) {
    (void)ssid; (void)password;
    return false;
}

bool hal_web_serve(void) {
    return false;
}

bool hal_wifi_connected(void) {
    return false;
}

void hal_wifi_ip(char *out, size_t out_len) {
    strncpy(out, "0.0.0.0", out_len - 1);
    out[out_len - 1] = '\0';
}

int hal_http_request(const char *method, const char *url,
                     const char *body, char *out, size_t out_len) {
    (void)method; (void)url; (void)body;
    if (out_len) out[0] = '\0';
    return 0;
}

bool hal_ble_available(void) {
    return false;
}

bool hal_ble_advertise(const char *name) {
    (void)name;
    return false;
}

bool hal_ble_connected(void) {
    return false;
}

bool hal_ble_notify(const char *text) {
    (void)text;
    return false;
}

bool hal_ble_message(char *out, size_t out_len) {
    if (out_len) out[0] = '\0';
    return false;
}

void hal_radio_poll(void) {
}
