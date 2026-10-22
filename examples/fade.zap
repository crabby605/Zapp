# Fade an LED up and down with PWM
# Wiring: LED + resistor -> GP10

repeat forever:
    pulse 16 on pin 10 at 1000hz
    sleep 150ms
    pulse 64 on pin 10 at 1000hz
    sleep 150ms
    pulse 160 on pin 10 at 1000hz
    sleep 150ms
    pulse 255 on pin 10 at 1000hz
    sleep 150ms
    pulse 64 on pin 10 at 1000hz
    sleep 150ms
