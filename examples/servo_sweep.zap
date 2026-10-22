# Sweep a servo between its end stops, then centre it
# Wiring: signal -> GP12, servo power from 5V (not the board's 3V3)

repeat 3:
    move servo on pin 12 to -90
    sleep 400ms
    move servo on pin 12 to 0
    sleep 400ms
    move servo on pin 12 to 90
    sleep 400ms

move servo on pin 12 to 0
