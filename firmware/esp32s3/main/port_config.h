#pragma once

#define ZAPP_CHIP           "esp32s3"
#define ZAPP_VARIANT        "core"

// GPIO0-GPIO48. Some are flash/PSRAM pins on a given module; the board
// profiles only name the safe ones.
#define ZAPP_GPIO_COUNT     49
// No LED behind the radio here; the value is just outside the GPIO range.
#define ZAPP_PIN_RADIO_LED  200

// Smallest common S3 module (N4): 4MB flash, 512KB SRAM.
#define ZAPP_FLASH_KB       4096
#define ZAPP_RAM_KB         512

// A board build (-D ZAPP_BOARD=...) knows its board; the generic one is told by the host.
#ifdef ZAPP_BOARD_NAME
#define ZAPP_DEFAULT_BOARD  ZAPP_BOARD_NAME
#else
#define ZAPP_DEFAULT_BOARD  "unknown"
#endif

// Storage. The store is mirrored in RAM and the USB drive lives in RAM. On a
// board with PSRAM both go there and scale with how much the board has
// (measured at start-up, port_esp32.c); without it they share the S3's
// internal RAM with Wi-Fi, Bluetooth and HTTPS, so they stay at these sizes.
#define ZAPP_STORE_KB         32     // flash for main.zap, its bytecode, modules/ and web/
#define ZAPP_DISK_KB          48     // the USB drive's size
