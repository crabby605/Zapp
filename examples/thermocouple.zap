# Read a K-type thermocouple through a MAX31855 over SPI
# Wiring: MISO and SCK to your board's SPI pins, CS -> A0 (MOSI unused by this chip)

config:
    spi mosi=MOSI miso=MISO sck=SCK cs=A0

use max31855

repeat forever:
    get data from max31855

    if max31855.fault:
        print "thermocouple fault"
    else:
        print "temp " + max31855.temp

    sleep 1s
