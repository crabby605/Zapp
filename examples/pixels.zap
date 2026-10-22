# Cycle a NeoPixel strip through red, green and blue
# Wiring: data -> GP16 (strip power from 5V)

set brightness on pin 16 to 64

repeat forever:
    set pixels on pin 16 to 255 0 0
    show pixels on pin 16
    sleep 500ms

    set pixels on pin 16 to 0 255 0
    show pixels on pin 16
    sleep 500ms

    set pixels on pin 16 to 0 0 255
    show pixels on pin 16
    sleep 500ms
