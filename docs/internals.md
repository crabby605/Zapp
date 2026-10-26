# Internals

## Architecture

```
.zap source  →  Lexer  →  Parser/Emitter  →  bytecode  →  VM  →  HAL  →  hardware
                (TypeScript compiler)           (uint8_t[])   (Core 1)   (Pico SDK / ESP-IDF)
                                                     │
                                                     └──→  VM  →  virtual board   (emulator, no hardware)
```

**Dual-core execution** on RP2040 and ESP32-S3:
- **Core 0** — USB CDC (serial REPL), TinyUSB, MSC drive, auto-sync (and Wi-Fi/BLE on the S3)
- **Core 1** — VM execution, HAL dispatch, sensor I/O

**USB composite device:**
- CDC serial port for the REPL and debug output
- MSC mass storage (the `Zapp Drive`) — edit `main.zap` like a file, changes auto-sync to flash
- HID keyboard + mouse — the board can type and click on the host it's plugged into


## Project structure

```
zapp/
  firmware/
    core/            Shared by every chip
      repl.c         Main loop: USB, REPL, LLM mode, auto-sync, VM hand-off
      vm.c           Bytecode VM (runs on the second core)
      hal.h          Hardware interface each port implements
      hal_radio.h    Wi-Fi / HTTP / web / BLE interface
      port.h         Per-chip glue: cores, reboot, flash sectors
      hal_common.c   HID queue, debug output, web file lookup
      usb_device.c   USB descriptors, CDC helpers
      usb_hid.c      Keyboard + mouse reports
      usb_msc.c      FAT12 drive (main.zap, modules/, web/)
      project_store.c  Flash-backed project storage
    rp2040/          Pico SDK port: CMakeLists.txt, HAL, CYW43 Wi-Fi/BLE, pico-sdk/
    esp32s3/         ESP-IDF port: main/ (HAL, Wi-Fi/BLE), partitions, sdkconfig
  compiler/          TypeScript compiler (lexer, emitter, opcodes, .zappmod parser)
  emulator/          Host build of the VM + a virtual board
  boards/            Board pin profiles (.zappboard)
  modules/           Sensor module definitions (.zappmod)
  examples/          Example .zap programs
  tests/             Jest suites (compiler, opcodes, end-to-end VM)
  ide/               Next.js web IDE
  mcp/               MCP server — lets Claude drive a board or the emulator
```

## Opcodes

The VM supports these bytecode instructions:

| Range | Category | Opcodes |
|-------|----------|---------|
| 0x01-0x02 | GPIO | write, read |
| 0x03-0x05 | PWM/Servo | set, off, servo |
| 0x06-0x07 | ADC | raw, voltage |
| 0x08-0x0C | I2C | write, read, scan, transform, init |
| 0x10-0x11 | Timing | sleep_us, sleep_ms |
| 0x20-0x24 | Stack | push_num, push_bool, push_str, pop, dup |
| 0x30-0x31 | Variables | store, load |
| 0x40-0x44 | Arithmetic | add, sub, mul, div, mod |
| 0x50-0x55 | Comparison | eq, neq, gt, lt, gte, lte |
| 0x60-0x62 | Logic | and, or, not |
| 0x70-0x72 | Control | jump, jump_if_false, jump_if_true |
| 0x80-0x81 | Functions | call, return |
| 0x90-0x91 | I/O | print, print_str |
| 0xA0-0xA3 | NeoPixel | set, set_all, brightness, show |
| 0xB0-0xB3 | SPI | init, transfer, cs, read_field |
| 0xC0-0xC8 | UART | init, write, write_str, read_bytes, read_line, available, flush, read_until, apply_parser |
| 0xD0-0xD3 | Display | init, clear, text, value |
| 0xE0-0xE2 | HID | key, type, mouse |
| 0xF0-0xF4 | Wi-Fi | connect, status, ip, http get, http post |
| 0xF5-0xF8 | BLE | advertise, notify, status, message |
| 0xF9-0xFA | Wi-Fi | start access point, serve web |
| 0xFF | Control | halt |

Every opcode in the table is implemented in `firmware/core/vm.c`; `tests/opcodes.test.ts`
fails the build if one is added to `vm.h` without an implementation, or if the
compiler's table drifts from the firmware's.

A pin operand of `0xFF` means "take the pin from the stack" — that's how a pin
can come from a variable or a function parameter.
