# Blink the board's LED
# LED is whichever pin your board's LED is on (pick the board next to Run).
# Board with only a NeoPixel? Try pixels.zap.

repeat forever:
    set pin LED high
    sleep 500ms
    set pin LED low
    sleep 500ms
