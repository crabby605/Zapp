# Pico W: publish BMP280 readings over Bluetooth, and take commands back
# Build the radio firmware: cmake .. -DZAPP_BOARD=pico_w
# Connect with nRF Connect, LightBlue or Bluefruit Connect.
# Wiring: SDA and SCL to your board's I2C pins (pick the board in the IDE)

use bmp280

advertise "zapp-sensor"

repeat forever:
    get data from bmp280

    if ble connected:
        notify "temp " + bmp280.temp

        text command = ble message
        if command == "led on":
            set pin 25 high
        if command == "led off":
            set pin 25 low

    sleep 2s
