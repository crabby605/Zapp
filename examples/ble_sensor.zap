# Publish BMP280 readings over Bluetooth, and take commands back
# Needs a board with Bluetooth: Pico W or any ESP32-S3.
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
            set pin LED high
        if command == "led off":
            set pin LED low

    sleep 2s
