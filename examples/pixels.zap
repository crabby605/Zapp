# Cycle the board's NeoPixel through red, green and blue
# For a strip, put its data pin in place of NEOPIXEL (strip power from 5V).

set brightness on pin NEOPIXEL to 64

repeat forever:
    set pixels on pin NEOPIXEL to 255 0 0
    show pixels on pin NEOPIXEL
    sleep 500ms

    set pixels on pin NEOPIXEL to 0 255 0
    show pixels on pin NEOPIXEL
    sleep 500ms

    set pixels on pin NEOPIXEL to 0 0 255
    show pixels on pin NEOPIXEL
    sleep 500ms
