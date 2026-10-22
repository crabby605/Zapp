# Read an MPU6050 straight off the I2C bus — no module, just its registers.
send 0 to i2c 0x68 at 0x6B          # wake it up (it starts asleep)

repeat forever:
    num ax = read 2 bytes from i2c 0x68 at 0x3B as signed 16-bit
    num az = read 2 bytes from i2c 0x68 at 0x3F as signed 16-bit
    print "tilt " + round(ax / 16384 * 90) + " deg, z " + az / 16384 + " g"
    sleep 500ms
