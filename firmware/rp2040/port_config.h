#pragma once

#define ZAPP_CHIP           "rp2040"
#define ZAPP_VARIANT        "core"

// Clock frequency in MHz. Safe range: 48-280.
#define ZAPP_CLOCK_MHZ      133

#if ZAPP_CLOCK_MHZ < 48 || ZAPP_CLOCK_MHZ > 280
#error "ZAPP_CLOCK_MHZ out of safe range (48-280)"
#endif

// User-addressable GPIOs (GP0-GP29)
#define ZAPP_GPIO_COUNT     30
// Virtual pin for an LED wired to the radio chip (Pico W: CYW43 WL_GPIO0).
#define ZAPP_PIN_RADIO_LED  32

#define ZAPP_FLASH_KB       2048
#define ZAPP_RAM_KB         264

// The radio build only runs on a Pico W; otherwise the host says which board.
#ifdef ZAPP_HAS_RADIO
#define ZAPP_DEFAULT_BOARD  "pico_w"
#else
#define ZAPP_DEFAULT_BOARD  "unknown"
#endif

// Storage. RP2040 boards have no PSRAM, and the store's RAM copy and the USB
// drive both live in its 264KB, so they stay small.
#define ZAPP_STORE_KB       32     // flash for main.zap, its bytecode, modules/ and web/
#define ZAPP_DISK_KB        48     // the USB drive's size
