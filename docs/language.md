# Language

## Variables and expressions

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

## Talking to chips

```zap
send 0x27 to i2c 0x76 at 0xF4
num ax = read 2 bytes from i2c 0x68 at 0x3B as signed 16-bit
bytes id = spi transfer [0x9F, 0, 0, 0] with cs 5
```

See SPEC.md for `bytes`, `bit N of x` and the rest.

## Control flow

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

## Functions

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

## GPIO

```zap
set pin 25 high
set pin 25 low
read pin 15
```

## Timing

```zap
sleep 500ms
sleep 1s
sleep 250us
```

## PWM, servo and ADC

```zap
pulse 128 on pin 10 at 1000hz    # duty 0-255; duty 0 turns the pin off
move servo on pin 12 to -90      # -90..90 degrees
read analog pin 26               # 0-65535
read analog pin 26 as voltage    # 0.0-3.3, GP26-29 only
```

## USB keyboard and mouse (HID)

```zap
type "hello"                     # types on the host the board is plugged into
press "ctrl+c"                   # ctrl / shift / alt / cmd + a-z 0-9 enter tab esc f1-f12 arrows
click left                       # left / right / middle
move mouse 10 -5
scroll -2
```

## NeoPixels

```zap
set brightness on pin 16 to 64
set pixel 0 on pin 16 to 255 0 0
set pixels on pin 16 to 0 0 255
show pixels on pin 16
```

## Sensors (via modules)

```zap
config:
    i2c sda=20 scl=21

use bmp280

get data from bmp280
print bmp280.temp
print bmp280.pressure
```

## Display (OLED)

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

## UART devices

```zap
config:
    uart tx=0 rx=1 baud=9600

use gps_nmea

repeat forever:
    get data from gps_nmea
    print gps_nmea.latitude
    sleep 1s
```

## SPI devices

```zap
config:
    spi mosi=19 miso=16 sck=18 cs=17

use max31855

get data from max31855
print max31855.temp
```

## Config block

```zap
config:
    i2c sda=20 scl=21
    uart tx=0 rx=1 baud=9600
    spi mosi=19 miso=16 sck=18 cs=17
```

## Not implemented yet

`list` and `class` from SPEC.md — the compiler rejects them with a clear error
rather than emitting something that won't run.
