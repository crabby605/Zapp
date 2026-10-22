# Zapp ⚡
> Hardware for humans.

Zapp is an open source programming language and ecosystem for microcontrollers. Designed for beginners, kids, and vibe coders. Fast enough to be useful, simple enough to learn in an afternoon.

```zap
repeat forever:
    set pin 25 high
    sleep 500ms
    set pin 25 low
    sleep 500ms
```

---

## Why Zapp?

Every existing option has a problem:

- **CircuitPython** — friendly but slow, GC pauses break timing, no LLM support
- **Arduino/C++** — fast but hostile to beginners
- **MicroPython** — middle ground but still Python syntax and overhead

Zapp is different:

- Reads like plain English
- Compiles to allocation-free bytecode, no GC, deterministic timing
- Native LLM support — Claude can directly control your hardware
- No terminal, no drivers, no toolchain — just a browser

---

## The Ecosystem

### zap-core
Full runtime for dual core MCUs. RP2040, nRF5340, STM32 and more.

### zap-minima
Same language, same features, same modules. Single core MCUs. ATmega, SAMD21, nRF52832.

### zap-addons
Chip specific extensions. Wi-Fi and BLE are implemented for the Pico W (CYW43439,
2.4GHz) behind `hal_radio.h` — build with `cmake -DZAPP_BOARD=pico_w`. ESP32 and
nRF targets need a HAL port; Thread and Zigbee are not implemented anywhere yet.

```
esp32   — wifi, bluetooth, zigbee, thread, espnow
rp2040  — direct PIO access
nrf     — BLE 5.3, matter, openthread
```

### zap-modules
Community sensor and peripheral library. `.zappmod` files hosted on GitHub, auto-fetched by the IDE. No install command, no package manager, no config files.

```zap
use bmp280      # fetched automatically from github.com/zap-lang/modules
use ssd1306

get data from bmp280
display.text "temp" bmp280.temp at 0 0
display.show()
```

---

## Getting Started

### 1. Flash Zapp onto your board

Hold BOOTSEL, plug in your Pico. A drive appears. Drag `zap-core-rp2040.uf2` onto it. Done.

> Download UF2: [zap.dev/firmware](https://zap.dev/firmware)

### 2. Open the IDE

Go to [zap.dev](https://zap.dev) in Chrome or Edge. Click **Connect**. Your board is detected automatically.

### 3. Write code

```zap
config:
    clock 133mhz
    i2c sda=20 scl=21

use bmp280

repeat forever:
    get data from bmp280
    print bmp280.temp
    sleep 1s
```

Click **Flash**. It runs.

---

## Language

> Status: everything below is implemented and covered by tests, except `list`,
> `class` and the radio addons — those are marked **planned** and the compiler
> rejects them with an explicit error.

### Types

```zap
num x = 42                 # a whole number: exact up to ±2.1 billion
num voltage = 3.3          # a decimal: 7 significant digits
whole steps = 2.7          # always whole — stores 2
decimal ratio = 1          # always a decimal
text name = "zap"
bool running = true
bytes reply = [0x01, 0xFF] # up to 64 bytes, for talking to chips
list temps = [0, 0, 0]     # planned
```

`num` keeps whole numbers and decimals apart behind the scenes, so counters,
millisecond timers and register values stay exact. A whole number that
overflows becomes a decimal instead of wrapping round to a negative.

### Arithmetic

```zap
print 7 / 2        # 3.5 — / always gives the real answer
print 7 // 2       # 3   — whole-number division (floored)
print -1 % 3       # 2   — remainder (floored, like Python)
print 2 ** 10      # 1024
print 0xFF + 0b1010

print abs(-3)              # brackets are optional with one value: round temp
print round 2.5            # 3
print min(a, b)            # also max
print clamp(x, 0, 100)
print map(raw, 0, 65535, 0, 100)
print sqrt(16)             # also sin cos tan, in degrees
print random(1, 6)         # whole, both ends included
```

### Bits

```zap
num value = (raw[0] << 8) | raw[1]     # & | ^ ~ << >>, on whole numbers
if bit 7 of status:
    print "ready"
```

### Bytes

```zap
bytes b = [1, 2, 0xFF]
print b[0]                # 1;  b[-1] is the last
set b[1] to 9
print length of b         # 3
print b as signed 16-bit  # also unsigned, 8/16/24/32-bit, big|little endian
```

### GPIO

```zap
set pin 25 high
set pin 25 low
read pin 25
```

### PWM

```zap
pulse 255 on pin 10
pulse 128 on pin 10 at 1000hz
```

### Servo

```zap
move servo on pin 12 to 90
move servo on pin 12 to -90
```

### ADC

```zap
read analog pin 26
read analog pin 26 as voltage
```

### I2C / Sensors

```zap
use bmp280

get data from bmp280
print bmp280.temp
print bmp280.pressure
```

### Talking to chips directly

No module needed: send and read bytes yourself. The buses use the board's own
SDA/SCL and SCK/MOSI/MISO pins unless `config:` names others.

```zap
send [0xF4, 0x27] to i2c 0x76
send 0x27 to i2c 0x76 at 0xF4                    # write a register
bytes raw = read 3 bytes from i2c 0x76 at 0xF7
num ax = read 2 bytes from i2c 0x68 at 0x3B as signed 16-bit

bytes id = spi transfer [0x9F, 0, 0, 0] with cs 5   # full duplex
send [0x06] to spi with cs 5
bytes data = read 4 bytes from spi with cs 5
```

### Timing

```zap
sleep 500ms
sleep 1s
sleep 250us
```

### Control flow

```zap
repeat 5:
    set pin 25 high
    sleep 500ms
    set pin 25 low
    sleep 500ms

repeat forever:
    get data from bmp280
    print bmp280.temp
    sleep 1s

if bmp280.temp > 30:
    set pin 25 high
else:
    set pin 25 low
```

### Functions

```zap
func blink pin times:
    repeat times:
        set pin pin high      # the parameter is the pin number
        sleep 500ms
        set pin pin low
        sleep 500ms

blink 25 3
```

### Wi-Fi (Pico W)

```zap
connect wifi to "network" with "secret"

if wifi connected:
    print "ip " + wifi ip
    text page = http get "http://example.com/api"
```

GET over plain HTTP, 63-byte responses, one request at a time.

Be the network instead, and serve the drive's `web/` folder (`/` is `web/index.html`):

```zap
start wifi "Zapp" with "secret"   # `with` is optional: open network
serve web
```
 Boards without a
radio stop with a clear error.

### Bluetooth LE (Pico W)

The board is a BLE peripheral with a Nordic UART service — any BLE terminal app
can connect to it.

```zap
advertise "zapp-sensor"

if ble connected:
    notify "temp 21"
    text command = ble message
```

### USB HID

The board is a USB keyboard and mouse to whatever it's plugged into.

```zap
type "hello"
press "ctrl+c"
click left
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

### Classes (planned)

```zap
# planned — not accepted by the compiler yet
class TempLogger:
    num last = 0

    func read:
        get data from bmp280
        last = bmp280.temp

    func print:
        print "temp" last

TempLogger logger = TempLogger()
logger.read()
logger.print()
```

---

## Config Block

```zap
config:
    clock 200mhz              # 48-280mhz on RP2040 (parsed, not applied yet)
    i2c sda=20 scl=21
    spi mosi=19 miso=16 sck=18 cs=17
    uart tx=0 rx=1 baud=9600
    target rp2040             # chip target, resolves addons
```

---

## LLM Mode

Zapp has a built-in protocol for LLM control. Claude can directly read and write your hardware.

```
1. Claude calls zapp_connect
2. MCP server sends magic bytes to MCU  →  ZPP!   (board replies ZPPA)
3. The REPL stops echoing and prompting; commands are framed instead
4. Claude calls tools: zapp_run, zapp_gpio_write, zapp_i2c_scan, zapp_read_output...
   every command is answered with ZPPA (ok) or ZPPE (error)
5. Claude calls zapp_disconnect
6. MCP server sends exit bytes  →  ZPPX
7. The human REPL resumes
```

The server lives in `mcp/` (`npx tsx mcp/server.ts`). `zapp_emulate` runs a
program on the host emulator, so Claude can develop and test with no board
attached.

Connect the MCP server, tell Claude what you want:

> "read the temperature from the BMP280 on I2C and print it every second"

Claude figures out the register map, handles the protocol, controls the pins. You watch it happen.

---

## Web IDE

[zap.dev](https://zap.dev) — no install, works in Chrome and Edge.

- Monaco editor with Zapp syntax highlighting
- Web Serial API — plug in board, click Connect
- Package browser — shows only modules compatible with your board
- AI panel — describe what you want, Claude writes the code
- Flash button — compile and flash in one click

Board capabilities are detected automatically on connect:

```
ZAPP:rp2040:core:2048:264:pico
      ^      ^    ^    ^    ^
      chip variant flash(KB) RAM(KB) board
```

Modules that require more RAM or flash than your board has are grayed out with an explanation.

---

## Module System

Modules are `.zappmod` files. Declarative, no code required. Community maintained.

```
module bmp280
type i2c
addr 0x76 alt=0x77
min_flash 4
min_ram 2
targets all
fields:
    temp num
    pressure num
```

The compiler generates all I2C sequences from the module definition. You never touch a register map.

Modules live at [github.com/zap-lang/modules](https://github.com/zap-lang/modules). The IDE fetches them automatically when you write `use bmp280`.

---

## Architecture

```
zap.dev (Next.js) — Lexer, Parser, Bytecode emitter (TypeScript)
    │
    │  Web Serial API (BC:<hex> payload)
    │
RP2040 running zap-core
    │
    ├── Core 0: USB CDC (REPL), MSC drive, HID
    └── Core 1: VM execution, HAL, PIO dispatch
```

### Compiler pipeline

```
.zap source
    │
  Lexer       →  token stream
    │
  Parser      →  AST
    │
  Emitter     →  bytecode (flat uint8_t array)
    │
  VM          →  hal_* calls
    │
  HAL         →  Pico SDK + PIO
    │
  hardware
```

### Memory layout (RP2040)

```
Flash (2MB):
  0x00000 - 0x0FFFF   bootloader     (64KB)
  0x10000 - 0x1FFFF   Zapp firmware   (64KB)
  0x20000 - 0x1FFFFF  script storage (1.875MB)

RAM (264KB):
  TinyUSB              8KB
  VM + bytecode        8KB
  module cache         32KB
  user heap            208KB
```

---

## Roadmap

### Phase 1 — prove it works
- [x] zap-core firmware (RP2040)
- [x] Lexer + parser + VM (GPIO, sleep, print)
- [x] USB REPL
- [x] blink.zap runs
- [x] Host emulator + test suite

### Phase 2 — useful
- [x] I2C + module system
- [x] bmp280.zappmod, ds3231.zappmod, mpu6050, ssd1306, gps_nmea, max31855
- [x] Full language: variables, expressions, if/else, functions
- [x] PWM, servo, ADC, SPI, NeoPixel, USB HID
- [x] Web IDE (Monaco + Web Serial + emulator)
- [ ] Auto module fetch from GitHub

### Phase 3 — LLM native
- [x] MCP server
- [x] Magic byte protocol
- [x] Claude controls hardware directly

### Phase 4 — ecosystem
- [ ] .zappmod registry + manifest.json
- [ ] ESP32 addons
- [ ] More sensor modules
- [ ] Hack Club workshop curriculum

---

## Repos

```
zap-lang/zap        — firmware, compiler, VM
zap-lang/modules    — community .zappmod files
zap-lang/ide        — zap.dev web IDE
```

---

## Contributing

Zapp is early. The best way to contribute right now is writing `.zappmod` files for sensors you own. Check [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

MIT