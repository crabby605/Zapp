#pragma once

// Zapp Firmware Config

#define ZAPP_VERSION        "0.1.0"

// Chip name, GPIO count, memory sizes: each port's own port_config.h.
#include "port_config.h"

// Feature flags
#define ZAPP_ENABLE_I2C     1
#define ZAPP_ENABLE_SPI     1
#define ZAPP_ENABLE_UART    1
#define ZAPP_ENABLE_ADC     1
#define ZAPP_ENABLE_PWM     1
#define ZAPP_ENABLE_PIO     1

// LLM mode magic bytes
// Enter: ZPP!  0x5A 0x50 0x50 0x21
// Exit:  ZPPX  0x5A 0x50 0x50 0x58
// Ack:   ZPPA  0x5A 0x50 0x50 0x41
// Error: ZPPE  0x5A 0x50 0x50 0x45
// Probe: ZPP?  0x5A 0x50 0x50 0x3F  -> board answers "ZPPI ZAPP:<chip>:..." (any mode)
// The board also sends that ZPPI line by itself whenever a host opens the port.
#define ZAPP_MAGIC_ENTER    { 0x5A, 0x50, 0x50, 0x21 }
#define ZAPP_MAGIC_EXIT     { 0x5A, 0x50, 0x50, 0x58 }
#define ZAPP_MAGIC_PROBE    { 0x5A, 0x50, 0x50, 0x3F }
#define ZAPP_MAGIC_IDENT    "ZPPI "
#define ZAPP_MAGIC_ACK      "ZPPA\r\n"
#define ZAPP_MAGIC_ERR      "ZPPE\r\n"
#define ZAPP_MAGIC_READY    "ZPPR\r\n"