# Pico W: read a BMP280 and post the temperature to a web endpoint
# Build the radio firmware first: cmake .. -DZAPP_BOARD=pico_w
# Wiring: SDA and SCL to your board's I2C pins (pick the board in the IDE)

use bmp280

connect wifi to "your-network" with "your-password"

if wifi connected:
    print "ip " + wifi ip
else:
    print "could not join wifi"

repeat forever:
    get data from bmp280
    print "temp " + bmp280.temp
    http post "http://example.com/readings" "from=zapp"
    sleep 60s
