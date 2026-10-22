# Basic GPIO: toggle an LED and read a button
# LED on pin 25, button on pin 15

repeat forever:
    read pin 15
    set pin 25 high
    sleep 250ms
    set pin 25 low
    sleep 250ms
