# Zapp

Hardware for humans. A programming language and runtime for microcontrollers.

Zapp compiles to allocation-free bytecode that runs on a dual-core VM. No GC pauses, no toolchain, no drivers. Write code in a browser, flash it to your board.

```zap
config:
    i2c sda=20 scl=21

use bmp280

repeat forever:
    get data from bmp280
    print bmp280.temp
    sleep 1s
```

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

## Building

### Firmware

One shared core (`firmware/core`: VM, REPL, USB drive, flash store) and one
folder per chip. A port implements `hal.h`, `hal_radio.h` and `port.h`.

**RP2040 / Pico W** (Pico SDK, pulled in as a submodule):

```bash
git submodule update --init --recursive
cd firmware/rp2040
cmake -B build && make -C build -j8                              # plain RP2040
cmake -B build-picow -DZAPP_BOARD=pico_w && make -C build-picow -j8  # Pico W, Wi-Fi + BLE
```

Output: `build/zapp.uf2` — hold BOOTSEL on your Pico, drag the file onto the drive.

**ESP32-S3** (ESP-IDF 5.5, Wi-Fi + BLE built in). One build per board, like
CircuitPython: `firmware/esp32s3/boards/<board>/sdkconfig.board` sets that
board's flash size and PSRAM (taken from CircuitPython's `mpconfigboard.mk`),
and the firmware knows which board it is.

```bash
. ~/esp/esp-idf/export.sh
cd firmware/esp32s3
idf.py -B build-xiao_esp32s3 -D ZAPP_BOARD=xiao_esp32s3 build
idf.py -B build-xiao_esp32s3 -p /dev/cu.usbmodem* flash   # hold BOOT, tap RESET first if it isn't in download mode
```

| Board build | PSRAM | Flash |
|---|---|---|
| `esp32s3_devkitc` (DevKitC-1 N8) | none | 8MB |
| `esp32s3_devkitc_n8r8` | 8MB octal | 8MB |
| `xiao_esp32s3` | 8MB octal | 8MB |
| `feather_esp32s3`, `qtpy_esp32s3` | 2MB quad (also runs on the no-PSRAM versions) | 4MB |
| `esp32s3_zero`, `lolin_s3_mini` | 2MB quad | 4MB |

Plain `idf.py build` (no `ZAPP_BOARD`) gives a build for any S3 with no PSRAM.
Octal and quad PSRAM are wired differently, so a board needs its own build.

TinyUSB comes from Espressif's component registry on the first build. Once Zapp
is running, the board's native USB port is the Zapp drive and REPL; type
`bootloader` in the REPL to drop back into download mode for the next flash.
Boards with Adafruit's TinyUF2 bootloader (Feather / QT Py S3) can take
`idf.py -B build-<board> uf2-app` → `uf2-app.bin` instead: double-tap reset, drag it on.

**How much a board stores.** `main.zap` gets 8KB; everything in `modules/` and
`web/` shares the rest, with no limit per file and up to 32 files. A board's
`boot_out.txt` says its number, and the IDE checks against it.

The board measures its PSRAM when it starts and sizes these from it (the
drive gets half, the store a quarter, within FAT12's and the partition's limits).
What it can't measure is the PSRAM's type, octal or quad — that has to be
right before it can talk to the chip at all, hence one build per board.

| Board | Shared by `modules/` and `web/` | Drive |
|---|---|---|
| RP2040 / Pico W, ESP32-S3 without PSRAM | about 21KB | 48KB |
| ESP32-S3 with 2MB PSRAM | about 500KB | 1MB |
| ESP32-S3 with 8MB PSRAM | about 1MB | about 2MB |

Moving a board between these sizes (e.g. flashing a PSRAM build) starts its
store fresh.

### Compiler (TypeScript)

```bash
cd compiler
npm install
npm run build    # compile to JS
npm run check    # type-check only
```

### Emulator

The firmware VM also builds for the host, linked against a virtual board, so
programs can be run and tested without hardware:

```bash
make -C emulator
emulator/zapp-emu --quiet "BC:011901110000012C011900110000012CFF"
# gpio 25=1
# gpio 25=0
```

Flags: `--gpio 15=1` presets an input pin, `--quiet` hides bus chatter,
`--no-radio` fakes a board without a radio, `--fb` dumps the display framebuffer
as hex, `--no-display` skips the ASCII framebuffer dump.

The virtual board answers I2C like the real parts: the **DS3231** returns the
host clock, the **BMP280** ~21 °C, the **MPU6050** a board lying flat, and the
**SSD1306** framebuffer is rendered. So `examples/clock.zap` prints the actual
time with no hardware attached.

### Tests

```bash
npm install      # once, in the repo root
npm test         # 113 tests: compiler, opcode-table sync, end-to-end VM runs
```

`tests/vm.test.ts` compiles Zapp source, runs the resulting bytecode through the
real VM in the emulator, and asserts on the hardware trace — so the compiler and
the firmware are checked against each other, not just against themselves.

### Web IDE

```bash
cd ide
npm install
npm run dev      # http://localhost:3000
```

- **First-run tour** of the IDE, with Skip (comes back next visit) and Don't
  show again; retake it from the Guide or the command palette
- **Several files at once**, Thonny-style: every program opens in its own tab,
  tabs come back after a refresh, unsaved ones show a dot and ask before closing.
  Middle-click closes a tab; ⌥W closes, ⌥[ / ⌥] switch
- **My programs** and **Examples** are separate views. Examples open read-only
  (book icon on the tab); "Make my own copy" or the copy button puts an editable
  one in My programs
- **Module manager**, like Arduino's Library Manager: search the library,
  Install / Update / Remove. Installing adds `use <module>` to the open program.
  The library is the repo's `modules/`; installed modules live in
  `workspace/modules/`, and only those compile into your programs (examples see
  the whole library). Writing `use bmp280` before installing it offers a
  one-click Install in the error strip
- **Compiles as you type** — errors in red on the line that caused them; board
  notes in yellow for things that compile but behave differently on the
  selected board (ADC2 with Wi-Fi on the S3, Pico W HTTP limits, USB pins…)
- **Run** (`⌘/Ctrl+Enter`) runs in the simulator with no board connected, or on
  the board when one is. The simulator pane stays hidden until you run in it or
  open it from the ribbon
- Command palette (⌘K), ⌘S save with format-on-save, a live serial REPL over
  Web Serial (Chrome or Edge; the simulator works in any browser)
- Leaving the page with unsaved changes asks first
- Hover any keyword for docs; completion knows the installed modules
  (`bmp280.` → its fields) and the selected board's pins (`set pin ` → `25 — LED`)

## Language

### Variables and expressions

```zap
num x = 42
text name = "zap"
bool running = true

x = x + 1
print "x is " + x          # + concatenates when either side is text
```

Arithmetic `+ - * / // % **` (`7 / 2` is 3.5, `7 // 2` is 3), comparisons
`== != > < >= <=`, logic `and or not`, bits `& | ^ ~ << >>`, hex `0x1F` and
binary `0b1010`, parentheses. Whole numbers stay exact to ±2.1 billion;
`whole` and `decimal` variables force one or the other. Maths: `abs round
floor ceil sqrt sin cos tan min max clamp map random`.

### Talking to chips

```zap
send 0x27 to i2c 0x76 at 0xF4
num ax = read 2 bytes from i2c 0x68 at 0x3B as signed 16-bit
bytes id = spi transfer [0x9F, 0, 0, 0] with cs 5
```

See SPEC.md for `bytes`, `bit N of x` and the rest.

### Control flow

```zap
if x > 40:
    set pin 25 high
else:
    set pin 25 low

repeat 5:                  # counted loop — a variable count works too
    print "tick"

repeat forever:
    print "tock"
    sleep 1s
```

### Functions

```zap
func blink pin times:
    repeat times:
        set pin pin high
        sleep 100ms
        set pin pin low
        sleep 100ms

blink 25 3
```

Positional parameters, called by name. A parameter can be used as a pin.

### GPIO

```zap
set pin 25 high
set pin 25 low
read pin 15
```

### Timing

```zap
sleep 500ms
sleep 1s
sleep 250us
```

### PWM, servo and ADC

```zap
pulse 128 on pin 10 at 1000hz    # duty 0-255; duty 0 turns the pin off
move servo on pin 12 to -90      # -90..90 degrees
read analog pin 26               # 0-65535
read analog pin 26 as voltage    # 0.0-3.3, GP26-29 only
```

### USB keyboard and mouse (HID)

```zap
type "hello"                     # types on the host the board is plugged into
press "ctrl+c"                   # ctrl / shift / alt / cmd + a-z 0-9 enter tab esc f1-f12 arrows
click left                       # left / right / middle
move mouse 10 -5
scroll -2
```

### NeoPixels

```zap
set brightness on pin 16 to 64
set pixel 0 on pin 16 to 255 0 0
set pixels on pin 16 to 0 0 255
show pixels on pin 16
```

### Sensors (via modules)

```zap
config:
    i2c sda=20 scl=21

use bmp280

get data from bmp280
print bmp280.temp
print bmp280.pressure
```

### Display (OLED)

```zap
config:
    i2c sda=4 scl=5

use oled

display on oled "Hello World!"                 # next free line, like print
display on oled "Temp" at 0 16                 # x y in pixels
display on oled bmp280.temp at 40 16 size 2    # any value, scaled 1-4x
clear oled                                     # blank it; lines restart at the top
```

`use oled` works with the common I2C OLEDs. At startup the board finds the
display at `0x3C` or `0x3D` and reads its status byte to tell an **SSD1306**
(0.96" 128×64 or 0.91" 128×32) from an **SH1106** (1.3"), then drives it
correctly. Name a specific chip with `use ssd1306` / `use sh1106`; detection
still corrects it if the hardware disagrees. No display connected stops the
program with "no display found".

- Without `at`, each `display` goes on the next line down and scrolls when the
  screen is full.
- Text replaces whatever is to its right in its rows, so a value that gets
  shorter (100 → 99) doesn't leave old digits behind.
- Only the rows that changed are sent to the display.

The emulator can pretend to be any of these: `--display ssd1306|ssd1306_32|sh1106|none`,
with `@3d` for the alternate address.

### UART devices

```zap
config:
    uart tx=0 rx=1 baud=9600

use gps_nmea

repeat forever:
    get data from gps_nmea
    print gps_nmea.latitude
    sleep 1s
```

### SPI devices

```zap
config:
    spi mosi=19 miso=16 sck=18 cs=17

use max31855

get data from max31855
print max31855.temp
```

### Config block

```zap
config:
    i2c sda=20 scl=21
    uart tx=0 rx=1 baud=9600
    spi mosi=19 miso=16 sck=18 cs=17
```

### Not implemented yet

`list` and `class` from SPEC.md — the compiler rejects them with a clear error
rather than emitting something that won't run.

## Radios (Wi-Fi + Bluetooth LE)

Wi-Fi and BLE are implemented for the **Pico W** (Infineon CYW43439) and every
**ESP32-S3** board. The S3 firmware always has them; the Pico W needs its own build:

```bash
cd firmware/rp2040
cmake -B build-picow -DZAPP_BOARD=pico_w && make -C build-picow -j8
```

```zap
connect wifi to "your-network" with "your-password"   # leave out `with` for an open network

if wifi connected:
    print "ip " + wifi ip
    text page = http get "http://example.com/api"
    print page
```

`connect wifi to "…" with "…"`, `wifi connected`, `wifi ip`, `http get "url"` and
`http post "url" "body"` are the client surface.

### Access point and web pages

```zap
start wifi "Zapp" with "password"   # leave out `with` for an open network
serve web
print "open http://" + wifi ip      # 192.168.4.1
```

`start wifi` makes the board its own network and hands out addresses to
phones and laptops that join. `serve web` serves the drive's `web/` folder on
port 80: `/` is `web/index.html`, `/style.css` is `web/style.css`. It works on
either network, joined or started. Pages can be any size the board's storage
holds (see above), with names up to 27 characters; the access point takes 8 clients.
 On a board with no radio the VM
stops with `Hardware Error: this board has no radio` instead of doing nothing
quietly, and the emulator reproduces both cases (`--no-radio` fakes a plain
RP2040), so radio programs are testable without hardware.

### Bluetooth LE

The board advertises as a BLE peripheral running a **Nordic UART service**, so
nRF Connect, LightBlue and Bluefruit Connect talk to it with no extra work:

```zap
advertise "zapp-sensor"

repeat forever:
    if ble connected:
        notify "temp 21"              # any value; sent as text

        text command = ble message    # what the phone sent, or nil
        if command == "led on":
            set pin 25 high
    sleep 2s
```

Implementation: `firmware/core/hal_radio.h` is the interface.
`firmware/rp2040/hal_radio_cyw43.c` (Wi-Fi, lwIP in threadsafe-background mode
because the VM runs on core 1) and `hal_ble_cyw43.c` (BLE, btstack on the CYW43
async context) are the Pico W backends, with the GATT database in
`zapp_ble.gatt`. `firmware/esp32s3/main/hal_radio_esp32.c` is the ESP32-S3
backend (esp_wifi, esp_http_client, esp_http_server, NimBLE).
`firmware/core/hal_radio_none.c` is every board without a radio. Opcodes live
in the `0xF0` block.

### What each chip can actually do

| Target | Radio | Status here |
|--------|-------|-------------|
| RP2040 (Pico, XIAO, Feather) | none | `hal_radio_none.c` — fails loudly |
| **Pico W / Pico 2 W** | 2.4GHz Wi-Fi 4 (802.11n) + BLE 5.2, CYW43439 | **Wi-Fi and BLE both built** |
| **ESP32-S3** | 2.4GHz Wi-Fi 4 + BLE 5 | **Wi-Fi, BLE, HTTPS and POST all built** (`firmware/esp32s3`) |
| ESP32-C3 | 2.4GHz Wi-Fi 4 + BLE 5 | same port minus native USB (it has none), so no drive or HID |
| ESP32-C5 | 2.4 **and 5GHz** Wi-Fi 6 + BLE 5 + 802.15.4 | same port; in mass production since April 2025, ESP-IDF ≥ 5.4 |
| nRF52/53 | BLE 5.3, Thread, Matter | port onto the nRF Connect SDK |
| nRF7002 companion | Wi-Fi 6, dual-band 2.4/5GHz | host MCU + nRF70 driver over SPI |

Two things worth being precise about: **no 5GHz on any Pico** — the CYW43439 is
2.4GHz only, so dual-band means moving to ESP32-C5 or an nRF7002 companion. And
**nothing here reaches Wi-Fi 6E/7**: the nRF7002 is Wi-Fi 6 dual-band and does
not do 6GHz, and 6E parts are outside what this firmware targets.

The S3 backend has none of the Pico W's HTTP limits below: `http post` works,
`https://` works (ESP-IDF's certificate bundle), and the access point uses
ESP-IDF's own DHCP server. Responses are still 63 bytes, as that's a Zapp string.

### Known limits of the Pico W backend

- `http get` only; `http post` returns a clear error on hardware (it works in
  the emulator). POST needs httpc's custom-request path.
- `http://` only — HTTPS needs mbedtls + altcp_tls linked in, which roughly
  doubles the flash cost.
- Response bodies are truncated to 63 bytes, because that's a Zapp string.
- One request in flight at a time.
- BLE is peripheral-only: one connection, one pending inbound message, no
  pairing or encryption (anything in range can connect). Messages are 63 bytes.
- The advertised name is dynamic, but the GATT device-name characteristic is
  fixed at "Zapp" — `gap_set_local_name` is a classic-Bluetooth call that isn't
  linked into an LE-only build.

## Module system (`.zappmod`)

A module file describes one part so programs can say `use tmp102` /
`get data from tmp102` / `print tmp102.temp`. The compiler turns the file into
ordinary bytecode; anything the file can't express is a named routine in the
firmware (`firmware/core/vm.c`) that the file refers to by name.

### What a module file can describe on its own

I2C parts read by register: an address, start-up register writes, and per
reading the register, how its bytes form a number, and the datasheet's maths.

```toml
[module]
name        = "tmp102"
version     = "1.0.0"
description = "TMP102 temperature sensor"
author      = "you"

[compat]
interface   = "i2c"

[i2c]
addr_default = 0x48

# [init] holds register = value writes (one byte each) sent on first use, for
# chips that must be woken — the MPU6050 needs 0x6B = 0x00. The TMP102 needs none.

[fields.temp]          # programs read tmp102.temp
type   = "num"         # or "bool"
reg    = 0x00
format = "i16_be"      # u8 i8 u16_be u16_le i16_be i16_le u24_be ... i32_le
shift  = 4             # optional, applied in this order:
bits   = 12            #   drop low bits, keep N bits (signed formats keep the sign),
mask   = 0x0FFF        #   keep these bits, multiply, add
scale  = 0.0625
offset = 0
```

`len` follows from `format`. Comments go on their own lines — everything after
`=` is the value. The IDE's **Module manager → New module** writes this
template with every line explained, and the editor points at mistakes.

### What needs firmware support

These module files work because the firmware has the routine they name; a new
one means adding C to `vm.c` and rebuilding:

| Kind | In the file | Routines that exist |
|---|---|---|
| Chip-specific maths | `transform = "..."` | `bmp280_temp` (°C) and `bmp280_pressure` (hPa), using the chip's calibration; `ds3231_time`, `ds3231_date`; `mpu6050_accel` (g, ±2g range), `mpu6050_gyro` (°/s, ±250°/s) |
| Older plain transforms | `transform = "..."` | `raw_u8`, `raw_u16_be/le`, `raw_i16_be/le`, `scaled_100`, `scaled_1000` (signed ÷100/÷1000), `bcd_byte` — `format` covers all of these |
| GPS (UART lines) | `parse = "..."` | `nmea_gga_lat`, `nmea_gga_lon`, `nmea_gga_alt`, `nmea_gga_fix`, `nmea_rmc_speed` |
| Screens | `[display] controller` | SSD1306 and SH1106 with a built-in 5×7 font, detected at start-up |
| SPI fields | `rx_len`, `bit_mask`, `bit_shift`, `scale`, `transform = "twos_complement_N"` | as used by `max31855` |

Not supported yet: a second address (`addr_alt` is ignored), multi-byte or
timed start-up sequences, and `min_flash_kb` / `targets` (informational only).

### Included modules

| Module | Interface | Reads |
|--------|-----------|-------|
| `bmp280` | I2C | `temp` (°C), `pressure` (hPa) |
| `ds3231` | I2C | `time`, `date` |
| `mpu6050` | I2C | `accel_x/y/z` (g), `gyro_x/y/z` (°/s) |
| `max31855` | SPI | thermocouple temperature |
| `gps_nmea` | UART | `latitude`, `longitude`, `altitude`, `fix`, `speed` |
| `hc05` | UART | Bluetooth serial |
| `oled` | Display | any SSD1306 / SH1106 I2C OLED, detected |
| `ssd1306`, `ssd1306_32`, `sh1106` | Display | one specific screen |

## REPL

When connected via serial (USB CDC), you get an interactive prompt:

```
Zapp v0.1.0 on rp2040 (core)
Type 'help' for commands. Ctrl+C = stop, Ctrl+D = reload.

> help
> set pin 25 high
> read pin 15
> identity
> reset
```

### Keyboard shortcuts

- **Ctrl+C** — stop running program
- **Ctrl+D** — soft reload (re-runs the last flashed program)

`BC:<hex>` runs bytecode **and saves it** as the boot program (the IDE's Flash).
`RUN:<hex>` runs it without saving — the REPL and one-off tools like `i2c scan`
use it, so they never overwrite your program.

### LLM mode

Magic bytes switch the REPL into a machine-readable framing: `ZPP!` enters (the
board replies `ZPPA`), every command is then answered with `ZPPA` on success or
`ZPPE` on error and no prompt or echo is sent, and `ZPPX` returns to the human
REPL.

**Identify.** Send `ZPP?` at any time, in any mode, and a Zapp board answers
`ZPPI ZAPP:rp2040:core:2048:264:<board>` on its own line. It also sends that line
by itself whenever a host opens the port. The IDE, REPL and MCP server only
treat a port as a Zapp board once it has answered, so they never latch onto
some other USB serial device.

The MCP server in `mcp/` speaks this protocol:

```bash
claude mcp add zapp -- npx tsx mcp/server.ts     # or use the checked-in .mcp.json
```

Tools: `zapp_list_boards`, `zapp_connect`, `zapp_run`, `zapp_emulate`,
`zapp_compile`, `zapp_gpio_write`, `zapp_gpio_read`, `zapp_i2c_scan`,
`zapp_repl`, `zapp_stop`, `zapp_read_output`, `zapp_list_modules`,
`zapp_disconnect`.

## USB drive (CircuitPython-style)

The board mounts as a `Zapp Drive` USB drive with:

```
Zapp Drive/
  main.zap          ← edit this file to program
  boot_out.txt      ← board info (read-only)
  modules/           ← .zappmod sensor files
```

Save `main.zap` (or drop `.zappmod` files into `modules/`) and it syncs to flash
within 1 second; deleting a module file removes it from the board too. The board
can't compile source yet, so the running program doesn't change: the REPL prints
`main.zap saved. Flash it from the Zapp IDE to run your changes.` and
`ZAPP:SRC_CHANGED`, and you press Flash in the IDE.

## Boards

Pick your board in the IDE and its pin names work in programs — including the
on-board LEDs, NeoPixels and buttons:

```zap
set pin LED high                         # whatever GPIO the LED is on
set pixels on pin NEOPIXEL to 0 255 0    # powers the NeoPixel first if needed
show pixels on pin NEOPIXEL
if read pin BUTTON:                      # true while pressed
    print "pressed"
```

Active-low LEDs and buttons are inverted for you when you use their names
(`set pin LED_RED high` lights the XIAO's red LED even though it's wired
active-low); raw GPIO numbers are never inverted.

| Profile | Board | Indicators |
|---|---|---|
| `pico` | Raspberry Pi Pico | `LED` |
| `pico_w` | Raspberry Pi Pico W | `LED` (on the Wi-Fi chip; pico_w build) |
| `xiao_rp2040` | Seeed XIAO RP2040 | `LED`, `LED_RED/GREEN/BLUE`, `NEOPIXEL` |
| `feather_rp2040` | Adafruit Feather RP2040 | `LED`, `NEOPIXEL`, `BUTTON` |
| `qtpy_rp2040` | Adafruit QT Py RP2040 | `NEOPIXEL`, `BUTTON` |
| `itsybitsy_rp2040` | Adafruit ItsyBitsy RP2040 | `LED`, `NEOPIXEL`, `BUTTON` |
| `kb2040` | Adafruit KB2040 | `NEOPIXEL`, `BUTTON` |
| `tiny2040` | Pimoroni Tiny 2040 | `LED_RED/GREEN/BLUE`, `BUTTON` |
| `rp2040_zero` | Waveshare RP2040-Zero | `NEOPIXEL` |
| `esp32s3_devkitc` | Espressif ESP32-S3-DevKitC-1 | `NEOPIXEL`, `BUTTON` |
| `feather_esp32s3` | Adafruit Feather ESP32-S3 | `LED`, `NEOPIXEL`, `BUTTON` |
| `qtpy_esp32s3` | Adafruit QT Py ESP32-S3 | `NEOPIXEL`, `BUTTON` |
| `xiao_esp32s3` | Seeed XIAO ESP32S3 | `LED` |
| `esp32s3_zero` | Waveshare ESP32-S3-Zero | `NEOPIXEL`, `BUTTON` |
| `lolin_s3_mini` | LOLIN S3 Mini | `NEOPIXEL`, `BUTTON` |

Every ESP32-S3 profile runs the same `firmware/esp32s3` build.

A profile is a small text file in `boards/`:

```ini
[board]
name  = "qtpy_rp2040"
chip  = "rp2040"
title = "Adafruit QT Py RP2040"
[pins]
NEOPIXEL = 12
BUTTON   = 21
A0       = 29
[indicators]
NEOPIXEL = "neopixel power=11"     # kind, then active_low / power=<gpio>
BUTTON   = "button active_low"
```

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

## License

MIT
