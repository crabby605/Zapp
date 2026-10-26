# Blink the onboard LED on a Raspberry Pi Pico
# Pin 25 is the built-in LED on RP2040 boards
# Or use LED as the LED pin
repeat forever:
    set pin LED high
    sleep 500ms
    set pin LED low
    sleep 500ms
