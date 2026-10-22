# Read time and date from a DS3231 RTC
# Wiring: SDA and SCL to your board's I2C pins (pick the board in the IDE)

use ds3231

repeat forever:
    get data from ds3231
    print ds3231.time
    print ds3231.date
    sleep 1s
