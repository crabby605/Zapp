# Boards

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
