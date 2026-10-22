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
                (TypeScript compiler)           (uint8_t[])   (Core 1)   (Pico SDK)
                                                     │
                                                     └──→  VM  →  virtual board   (emulator, no hardware)
```

**Dual-core execution** on RP2040:
- **Core 0** — USB CDC (serial REPL), TinyUSB, MSC drive, auto-sync
- **Core 1** — VM execution, HAL dispatch, sensor I/O

**USB composite device:**
- CDC serial port for the REPL and debug output
- MSC mass storage (the `Zapp Drive`) — edit `main.zap` like a file, changes auto-sync to flash
- HID keyboard + mouse — the board can type and click on the host it's plugged into

## Building

### Firmware (C, Pico SDK)

```bash
# Prerequisites: arm-none-eabi-gcc, cmake, pico-sdk
export PICO_SDK_PATH=/path/to/pico-sdk

mkdir build && cd build
cmake ..
make -j8
```

Output: `build/zapp.uf2` — hold BOOTSEL on your Pico, drag the file onto the drive.

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

- Real files: the IDE reads and writes `workspace/`, with tabs, dirty markers,
  ⌘S save (and format-on-save), new/rename/delete; examples are copied in rather
  than overwriting your buffer
- Command palette (⌘K), activity bar, resizable panels, status bar
- **Compiles as you type** — errors appear in the gutter on the line that caused
  them, and the header shows how much of the 2048-byte budget you've used
- **Run** (`⌘/Ctrl+Enter`) executes the program in the emulator and prints every
  pin, bus and message it touches — no board required
- **Flash** (`⌘/Ctrl+S`) and a live serial REPL over Web Serial, with Stop and
  Reload buttons (Chrome or Edge; the emulator works in any browser)
- Panels: **Run** (the hardware trace as a filterable table), **Display** (the
  OLED framebuffer drawn pixel-for-pixel), **Pins** (the board's pin map with the
  pins your program drove), **Problems**, and **Serial**
- Hover any keyword for docs; completion knows the loaded modules
  (`bmp280.` → its fields) and the selected board's pins (`set pin ` → `25 — LED`)
- Run configuration: preset input pins (`15=1`) and simulate a radio-less board

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

Wi-Fi and BLE are implemented for the **Pico W / Pico 2 W** (Infineon CYW43439).
Build the radio firmware with a board flag:

```bash
mkdir build-picow && cd build-picow
cmake .. -DZAPP_BOARD=pico_w -DPICO_SDK_PATH=../pico-sdk
make -j8            # 519KB flash, 162KB RAM (vs 132KB/111KB without a radio)
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
either network, joined or started. Limits: 2KB per file, file names up to 19
characters, 8 files across `modules/` and `web/`, 8 clients on the access point.
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

Implementation: `include/hal_radio.h` is the interface, `src/hal_radio_cyw43.c`
(Wi-Fi, lwIP in threadsafe-background mode because the VM runs on core 1) and
`src/hal_ble_cyw43.c` (BLE, btstack on the CYW43 async context) are the Pico W
backends, `src/hal_radio_none.c` is every other board. The GATT database is
`src/zapp_ble.gatt`, compiled to a header at build time. Opcodes live in the
`0xF0` block.

### What each chip can actually do

| Target | Radio | Status here |
|--------|-------|-------------|
| RP2040 (Pico, XIAO, Feather) | none | `hal_radio_none.c` — fails loudly |
| **Pico W / Pico 2 W** | 2.4GHz Wi-Fi 4 (802.11n) + BLE 5.2, CYW43439 | **Wi-Fi and BLE both built** |
| ESP32-C3/S3 | 2.4GHz Wi-Fi 4 + BLE 5 | needs a `hal_esp32.c` port onto ESP-IDF |
| ESP32-C5 | 2.4 **and 5GHz** Wi-Fi 6 + BLE 5 + 802.15.4 | same port; in mass production since April 2025, ESP-IDF ≥ 5.4 |
| nRF52/53 | BLE 5.3, Thread, Matter | port onto the nRF Connect SDK |
| nRF7002 companion | Wi-Fi 6, dual-band 2.4/5GHz | host MCU + nRF70 driver over SPI |

Two things worth being precise about: **no 5GHz on any Pico** — the CYW43439 is
2.4GHz only, so dual-band means moving to ESP32-C5 or an nRF7002 companion. And
**nothing here reaches Wi-Fi 6E/7**: the nRF7002 is Wi-Fi 6 dual-band and does
not do 6GHz, and 6E parts are outside what this firmware targets.

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

Modules are declarative sensor definitions. No code — the compiler generates all I2C/UART sequences from the file.

### Format

```toml
[module]
name        = "sensor_name"
version     = "1.0.0"
description = "What it is"
author      = "you"

[compat]
min_flash_kb = 4
min_ram_kb   = 2
targets      = ["all"]
interface    = "i2c"            # i2c | uart | spi

[i2c]                           # for I2C modules
addr_default = 0x76
addr_alt     = 0x77

[init]                          # registers written before first read
0xF4 = 0xB7
0xF5 = 0xB0

[fields.temp]                   # each field becomes module.field in Zapp
type      = "num"
reg       = 0xFA
len       = 3
transform = "bmp280_temp"
```

### How it works

The `.zappmod` file tells the compiler everything it needs:

1. **`[i2c]`** — device address on the bus
2. **`[init]`** — config registers to write before reading (emitted as `OP_I2C_WRITE` bytecode)
3. **`[fields.*]`** — which register to read, how many bytes, and which transform to apply

When you write `get data from bmp280`, the compiler emits:
```
OP_I2C_WRITE  0x76 0xF4 0x01 0xB7    # init register (first call only)
OP_I2C_WRITE  0x76 0xF5 0x01 0xB0    # init register (first call only)
OP_I2C_READ   0x76 0xFA 0x03         # read 3 bytes from temp register
OP_TRANSFORM  0x09                    # bmp280_temp transform
OP_STORE      0x00                    # save to slot 0
OP_I2C_READ   0x76 0xF7 0x03         # read 3 bytes from pressure register
OP_TRANSFORM  0x0A                    # bmp280_pressure transform
OP_STORE      0x01                    # save to slot 1
```

### UART modules

UART modules (GPS, Bluetooth) use a stream protocol:

```toml
[compat]
interface    = "uart"

[uart]
baud         = 9600
bits         = 8
parity       = "none"
stop_bits    = 1

[fields.latitude]
type         = "num"
read         = "line"
filter       = "$GPGGA"
parse        = "nmea_gga_lat"
```

### Included modules

| Module | Interface | Description |
|--------|-----------|-------------|
| `bmp280` | I2C | Temperature + pressure sensor |
| `ds3231` | I2C | Real-time clock |
| `mpu6050` | I2C | 6-axis accelerometer/gyroscope |
| `gps_nmea` | UART | Generic NMEA GPS receiver |
| `hc05` | UART | HC-05 Bluetooth module |
| `max31855` | SPI | Thermocouple amplifier |
| `ssd1306` | Display | 128×64 0.96" I2C OLED |

### Writing a new module

1. Create `modules/yourdevice.zappmod`
2. Fill in `[module]`, `[compat]`, interface config, and `[fields]`
3. If the device needs a new transform, add it to the VM (`vm.c` transform switch) and emitter (`TRANSFORM_IDS`)
4. Use it: `use yourdevice` / `get data from yourdevice`

### Available transforms

| Transform | ID | Description |
|-----------|-----|-------------|
| `raw_u8` | 0x00 | First byte as unsigned number |
| `raw_u16_be` | 0x01 | 2 bytes big-endian unsigned |
| `raw_u16_le` | 0x02 | 2 bytes little-endian unsigned |
| `raw_i16_be` | 0x03 | 2 bytes big-endian signed |
| `raw_i16_le` | 0x04 | 2 bytes little-endian signed |
| `scaled_100` | 0x05 | Signed 16-bit / 100 |
| `scaled_1000` | 0x06 | Signed 16-bit / 1000 |
| `twos_complement_16` | 0x07 | 2 bytes big-endian signed |
| `bcd_byte` | 0x08 | One BCD byte as a number |
| `bmp280_temp` | 0x09 | BMP280 temperature compensation |
| `bmp280_pressure` | 0x0A | BMP280 pressure compensation |
| `ds3231_time` | 0x0B | BCD time → "HH:MM:SS" |
| `ds3231_date` | 0x0C | BCD date → "DD/MM/YYYY" |
| `mpu6050_accel` | 0x0D | Raw / 16384 → g-force |
| `mpu6050_gyro` | 0x0E | Raw / 131 → degrees/sec |

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
  include/           C headers (vm.h, hal.h, config.h, ...)
  src/               C sources
    main.c           Core 0: USB, REPL, LLM mode, auto-sync
    vm.c             Core 1: bytecode VM
    hal_rp2040.c     HAL implementation (GPIO, PWM, servo, ADC, I2C, SPI, UART, PIO)
    usb_device.c     USB device library: descriptors, CDC helpers
    usb_hid.c        HID library: keyboard + mouse reports
    usb_msc.c        FAT12 mass storage driver
    uart_ring.c      Byte ring buffer (cross-core debug, UART RX)
    project_store.c  Flash-backed script storage
  compiler/          TypeScript compiler
    src/
      lexer.ts       Tokenizer
      emitter.ts     Parser + bytecode emitter
      opcodes.ts     Opcode/transform/parser id tables (mirrors vm.h)
      modfile.ts     .zappmod file parser
      index.ts       Public API + built-in modules
  modules/           Sensor module definitions (.zappmod)
  examples/          Example .zap programs
  pio/               PIO program (ws2812)
  emulator/          Host build of the VM + a virtual board
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
| 0xFF | Control | halt |

Every opcode in the table is implemented in `src/vm.c`; `tests/opcodes.test.ts`
fails the build if one is added to `vm.h` without an implementation, or if the
compiler's table drifts from the firmware's.

A pin operand of `0xFF` means "take the pin from the stack" — that's how a pin
can come from a variable or a function parameter.

## License

MIT
