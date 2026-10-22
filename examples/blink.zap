# Blink the onboard LED on a Raspberry Pi Pico
# Pin 25 is the built-in LED on RP2040 boards

repeat forever:
    set pin 25 high
    sleep 500ms
    set pin 25 low
    sleep 500ms
