#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Zapp radio HAL
// One interface, several silicon paths. Only chips with a radio implement it:
//
//   src/hal_radio_none.c    RP2040 and anything else with no radio (default)
//   src/hal_radio_cyw43.c   Pico W / Pico 2 W — CYW43439, 2.4GHz Wi-Fi 4
//                           (cmake -DZAPP_BOARD=pico_w)
//
// An ESP32 or nRF port implements the same functions against its own stack.

// False when this board has no radio at all — the VM reports that to the user
// instead of silently doing nothing.
bool hal_radio_available(void);

// Join an access point. Blocks until associated or the timeout expires.
bool hal_wifi_connect(const char *ssid, const char *password, uint32_t timeout_ms);
bool hal_wifi_connected(void);

// Become an access point (192.168.4.1, hands out addresses over DHCP).
// An empty password makes an open network.
bool hal_wifi_start_ap(const char *ssid, const char *password);

// Serve the drive's web/ folder on port 80; "/" is web/index.html.
bool hal_web_serve(void);

// Shared by every port's web server (hal_common.c). `path` is what follows the
// leading "/" of a request; the name is false when the store can't hold it.
bool web_file_name(const char *path, char *name, size_t name_len);
const char *web_content_type(const char *name);

// Current IPv4 address as text ("0.0.0.0" when not joined).
void hal_wifi_ip(char *out, size_t out_len);

// One blocking HTTP request. Returns the status code (0 on transport failure)
// and copies up to out_len-1 bytes of the response body into `out`.
// `body` is NULL for GET.
int hal_http_request(const char *method, const char *url,
                     const char *body, char *out, size_t out_len);

// Bluetooth Low Energy
// The board is a BLE peripheral running a Nordic UART service, so phone apps
// (nRF Connect, LightBlue, Bluefruit) can connect, read notifications and send
// text back.

bool hal_ble_available(void);

// Start advertising under this name. Safe to call more than once.
bool hal_ble_advertise(const char *name);
bool hal_ble_connected(void);

// Send text to the connected central. False if nobody is listening.
bool hal_ble_notify(const char *text);

// Take the most recent message the central sent, if there is one.
bool hal_ble_message(char *out, size_t out_len);

// Drive an LED wired to the radio chip (Pico W's on-board LED). False when
// this board has no such LED.
bool hal_radio_led(bool on);

// Service the network stack. Called from the VM between instructions and from
// the USB loop, so a program that never sleeps still keeps the link alive.
void hal_radio_poll(void);
