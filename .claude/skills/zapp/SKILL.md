---
name: zapp
description: Write, emulate and flash Zapp programs for microcontrollers. Use when the user asks to program a board, blink an LED, read a sensor (BMP280, DS3231, MPU6050, GPS, thermocouple), drive an OLED, use the board as a USB keyboard/mouse, or mentions Zapp, .zap files, .zappmod modules, or the Zapp REPL/emulator.
---

# Zapp

Zapp is a small language for microcontrollers. Source compiles to bytecode that
runs on a VM in the board's firmware — no toolchain, no drivers, no flashing
cycle. The same VM runs on the host as an emulator, so **you can test programs
without hardware**.

## The loop to follow

1. Write the program (`.zap` source).
2. **Emulate it** — `emulator/zapp-emu` (or the `zapp_emulate` MCP tool) prints
   every hardware effect. Do this before touching a board; it catches compile
   errors and logic bugs in a second.
3. Flash it, if a board is attached: paste the `BC:` payload into the REPL, use
   the IDE's Flash button, or the `zapp_run` MCP tool.

```bash
npx tsx -e "console.log(require('./compiler/src/index').compileSourceToPayload(require('fs').readFileSync('prog.zap','utf8')))"   # → BC:...
make -C emulator && emulator/zapp-emu --quiet "$(cat payload.hex)"                                                                # → trace
npx jest                                                                                                                          # → 83 tests
```

## Language

Indentation-based, one statement per line, `#` comments.

```zap
config:                          # optional, comes first
    i2c sda=20 scl=21
    uart tx=0 rx=1 baud=9600
    spi mosi=19 miso=16 sck=18 cs=17

num x = 42                       # num / whole / decimal / text / bool / bytes
text name = "zap"
bool on = true
x = x + 1                        # + - * / // % **, comparisons, and/or/not
set x to x + 1                   # same thing, in words
print "x is " + x                # + concatenates when either side is text
print 7 / 2                      # 3.5; 7 // 2 is 3; -1 % 3 is 2 (floored)
whole n = 2.7                    # always whole (stores 2); decimal r = 1 always a decimal
print round(x / 3)               # abs round floor ceil sqrt sin cos tan(degrees)
print clamp(x, 0, 100)           # min max clamp map(x, a, b, c, d) random(1, 6)
num v = (0x12 << 8) | 0b1010     # hex, binary, & | ^ ~ << >>; bit 7 of v -> bool

set pin 25 high                  # GPIO out
read pin 15                      # GPIO in (prints); usable in expressions
pulse 128 on pin 10 at 1000hz    # PWM, duty 0-255 (0 turns the pin off)
move servo on pin 12 to -90      # servo, -90..90 degrees
read analog pin 26 as voltage    # ADC on GP26-29

sleep 500ms                      # ms / s / us

repeat 5:                        # counted loop (a variable count works too)
    set pin 25 high
    sleep 100ms
    set pin 25 low
    sleep 100ms

repeat forever:
    print "tick"
    sleep 1s

if x > 40:
    print "big"
else:
    print "small"

func blink pin times:            # positional parameters, call by name
    repeat times:
        set pin pin high
        sleep 100ms
        set pin pin low
        sleep 100ms

blink 25 3
```

### Talking to chips directly — no module needed

The buses use the board's SDA/SCL and SCK/MOSI/MISO unless `config:` names
other pins.

```zap
bytes cmd = [0xF4, 0x27]                          # up to 64 bytes; cmd[0], cmd[-1]
send cmd to i2c 0x76                              # data: bytes, text, or one number
send 0x27 to i2c 0x76 at 0xF4                     # `at` = register
bytes raw = read 3 bytes from i2c 0x76 at 0xF7
num ax = read 2 bytes from i2c 0x68 at 0x3B as signed 16-bit
print raw as unsigned 24-bit                      # 8/16/24/32-bit, big|little endian
set raw[0] to 0                                   # length of raw -> 3

bytes id = spi transfer [0x9F, 0, 0, 0] with cs 5   # full duplex, any cs pin
send [0x06] to spi with cs 5
bytes data = read 4 bytes from spi with cs 5
```

### Sensors and displays

```zap
use bmp280                       # module files live in modules/*.zappmod
get data from bmp280             # reads every field into module.field
print bmp280.temp

use ssd1306                      # 128x64 OLED: 8 lines of 21 characters
clear ssd1306
show "Temperature:" on ssd1306 line 0
show bmp280.temp on ssd1306 line 1
```

Bundled modules: `bmp280` (temp/pressure, I2C), `ds3231` (clock, I2C),
`mpu6050` (accel/gyro, I2C), `max31855` (thermocouple, SPI), `gps_nmea`
(lat/lon/alt/fix/speed, UART), `hc05` (Bluetooth serial, UART), `ssd1306`
(display, I2C).

### USB HID — the board types on the host it's plugged into

```zap
type "hello"                     # types the text
press "ctrl+c"                   # modifiers: ctrl shift alt cmd; keys a-z 0-9 enter tab esc f1-f12 arrows
click left                       # left / right / middle
move mouse 10 -5                 # relative pixels
scroll -2
```

### NeoPixels

```zap
set pixel 0 on pin 16 to 255 0 0
set pixels on pin 16 to 0 0 255
set brightness on pin 16 to 64
show pixels on pin 16
```

### Wi-Fi — Pico W and ESP32-S3

```zap
connect wifi to "network" with "secret"     # leave out `with` for an open network
if wifi connected:
    print "ip " + wifi ip
    text page = http get "http://example.com/api"

start wifi "Zapp" with "secret123"          # or be the network
serve web                                   # serves web/index.html from the drive
```

The Pico W needs the radio build (`-DZAPP_BOARD=pico_w`); every ESP32-S3 build
has the radio. Boards without one stop with `Hardware Error: this board has no
radio`; the emulator reproduces that with `--no-radio`. Responses are truncated
to 63 bytes, one request at a time. The Pico W does GET over `http://` only; the
ESP32-S3 also does POST and `https://`.

### Bluetooth LE — Pico W only

```zap
advertise "zapp-sensor"

repeat forever:
    if ble connected:
        notify "temp 21"              # any value, sent as text
        text command = ble message    # what the phone sent, or nil
    sleep 2s
```

A Nordic UART service, so nRF Connect / LightBlue / Bluefruit Connect work with
no extra setup. Peripheral only, one connection, no pairing, 63-byte messages.

## Not implemented yet

`list` and `class` are in SPEC.md but not built — the compiler rejects them with
a clear error. Don't write programs that use them. No Thread or Zigbee on any
target; no 5GHz or Wi-Fi 6 (the Pico W radio is 2.4GHz only); BLE is peripheral
only (the board can't scan for or connect to other devices).

## Constraints that bite

- Bytecode must fit **2048 bytes** (`BC_BUF_SIZE`); the REPL rejects more.
- 64 variable slots total — module fields, variables, loop counters and
  function parameters all draw from the same pool.
- Strings are 63 bytes; bytes values and bus reads are 64 bytes; the stack is 64 values deep.
- Whole numbers are int32 (exact to ±2.1 billion); decimals are float32 (7 digits).
  Bit operators truncate decimals to whole numbers first.
- Pins in `set pin` / `pulse` / `move servo` are literals unless the value comes
  from a variable or parameter (the compiler emits a stack pin for that).
- Servo trim lives in `SERVO_MIN_US`/`SERVO_MAX_US` in each port's HAL
  (`firmware/rp2040/hal_rp2040.c`, `firmware/esp32s3/main/hal_esp32.c`) — real
  servos need it.

## Where things live

```
compiler/src/    lexer.ts, emitter.ts (parser + codegen), opcodes.ts, modfile.ts
firmware/core/   shared firmware: vm.c (the VM), vm.h (the opcode table — the
                 contract with the compiler), repl.c, usb_*.c, project_store.c
firmware/rp2040/ Pico SDK port: hal_rp2040.c, CYW43 Wi-Fi/BLE, CMakeLists.txt
firmware/esp32s3/ ESP-IDF port: main/hal_esp32.c, main/hal_radio_esp32.c
emulator/        zapp_emu.c: the VM plus a virtual board; `make` builds zapp-emu
tests/           jest: compiler, opcode-table sync, and end-to-end VM runs
ide/             Next.js web IDE — `npm run dev`, then localhost:3000
mcp/             MCP server exposing the board and emulator as tools
modules/         .zappmod sensor definitions (declarative, no code)
```

## Adding a sensor module

Write `modules/<name>.zappmod` — `[module]`, `[compat] interface = i2c|uart|spi`,
the bus section, optional `[init]` register writes, and one `[fields.x]` block
per reading. For I2C, describe each reading with `reg`, `format` (`u8`, `i16_be`,
`u24_le`…) and optional `shift`, `bits`, `mask`, `scale`, `offset`, `type = "bool"`
— see docs/modules.md. Only maths those can't express needs a new
transform: add it to the `TransformId` enum in `firmware/core/vm.c` **and** to
`TRANSFORM_IDS` in `compiler/src/opcodes.ts` — `tests/opcodes.test.ts` fails if
the two drift.

## Flashing firmware

RP2040: `cd firmware/rp2040 && cmake -B build && make -C build -j8` →
`build/zapp.uf2` (`-B build-picow -DZAPP_BOARD=pico_w` for the Wi-Fi build).
To install on an RP2040, hold BOOTSEL, plug the board in, and drop the `.uf2`
on the drive that appears.
ESP32-S3: `cd firmware/esp32s3 && idf.py -B build-<board> -D ZAPP_BOARD=<board> build flash`,
one build per board in `boards/` (hold BOOT and tap RESET
first if it isn't in download mode).
Running Zapp, the board mounts its own drive with `main.zap`, `modules/` and
`web/` on it; saving a file there auto-syncs it to flash.
