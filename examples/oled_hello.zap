# Text on an I2C OLED. `use oled` works with any of the common ones: the board
# detects SSD1306 (0.96" 128x64, 0.91" 128x32) or SH1106 (1.3") and its address.
# Wiring: SDA and SCL to your board's I2C pins (pick the board in the IDE)

use oled

clear oled
display on oled "Hello World!"            # first free line
display on oled "Zapp v0.1.0"             # ...and the next one down
display on oled "Hardware" at 0 32 size 2
display on oled "for humans." at 0 52
