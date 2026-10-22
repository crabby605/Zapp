# Read temperature from a BMP280 sensor and print it every second
# Wiring: SDA and SCL to your board's I2C pins (pick the board in the IDE)

use bmp280

repeat forever:
    get data from bmp280
    print bmp280.temp
    print bmp280.pressure
    sleep 1s
