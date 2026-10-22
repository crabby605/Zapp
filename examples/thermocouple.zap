# Read a K-type thermocouple through a MAX31855 over SPI
# Wiring: MISO -> GP16, SCK -> GP18, CS -> GP17 (MOSI unused by this chip)

config:
    spi mosi=19 miso=16 sck=18 cs=17

use max31855

repeat forever:
    get data from max31855

    if max31855.fault:
        print "thermocouple fault"
    else:
        print "temp " + max31855.temp

    sleep 1s
