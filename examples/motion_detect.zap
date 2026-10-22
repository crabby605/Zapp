# Read accelerometer data from MPU6050
# Wiring: SDA and SCL to your board's I2C pins (pick the board in the IDE)

use mpu6050

repeat forever:
    get data from mpu6050
    print "accel:"
    print mpu6050.accel_x
    print mpu6050.accel_y
    print mpu6050.accel_z
    sleep 100ms
