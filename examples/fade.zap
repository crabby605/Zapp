# Fade an LED up and down with PWM
# Wiring: LED + resistor -> A0 (any pin works; change A0 to match)

repeat forever:
    pulse 16 on pin A0 at 1000hz
    sleep 150ms
    pulse 64 on pin A0 at 1000hz
    sleep 150ms
    pulse 160 on pin A0 at 1000hz
    sleep 150ms
    pulse 255 on pin A0 at 1000hz
    sleep 150ms
    pulse 64 on pin A0 at 1000hz
    sleep 150ms
