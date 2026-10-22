# Turn a fan on when the BMP280 reads above target, off when it drops below
# Wiring: SDA and SCL to your board's I2C pins (pick the board in the IDE), fan relay -> GP15

use bmp280

num target = 28

repeat forever:
    get data from bmp280
    print "temp " + bmp280.temp

    if bmp280.temp > target:
        set pin 15 high
        print "fan on"
    else:
        set pin 15 low

    sleep 2s
