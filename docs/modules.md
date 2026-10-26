# Module system (`.zappmod`)

A module file describes one part so programs can say `use tmp102` /
`get data from tmp102` / `print tmp102.temp`. The compiler turns the file into
ordinary bytecode; anything the file can't express is a named routine in the
firmware (`firmware/core/vm.c`) that the file refers to by name.

## What a module file can describe on its own

I2C parts read by register: an address, start-up register writes, and per
reading the register, how its bytes form a number, and the datasheet's maths.

```toml
[module]
name        = "tmp102"
version     = "1.0.0"
description = "TMP102 temperature sensor"
author      = "you"

[compat]
interface   = "i2c"

[i2c]
addr_default = 0x48

# [init] holds register = value writes (one byte each) sent on first use, for
# chips that must be woken — the MPU6050 needs 0x6B = 0x00. The TMP102 needs none.

[fields.temp]          # programs read tmp102.temp
type   = "num"         # or "bool"
reg    = 0x00
format = "i16_be"      # u8 i8 u16_be u16_le i16_be i16_le u24_be ... i32_le
shift  = 4             # optional, applied in this order:
bits   = 12            #   drop low bits, keep N bits (signed formats keep the sign),
mask   = 0x0FFF        #   keep these bits, multiply, add
scale  = 0.0625
offset = 0
```

`len` follows from `format`. Comments go on their own lines — everything after
`=` is the value. The IDE's **Module manager → New module** writes this
template with every line explained, and the editor points at mistakes.

## What needs firmware support

These module files work because the firmware has the routine they name; a new
one means adding C to `vm.c` and rebuilding:

| Kind | In the file | Routines that exist |
|---|---|---|
| Chip-specific maths | `transform = "..."` | `bmp280_temp` (°C) and `bmp280_pressure` (hPa), using the chip's calibration; `ds3231_time`, `ds3231_date`; `mpu6050_accel` (g, ±2g range), `mpu6050_gyro` (°/s, ±250°/s) |
| Older plain transforms | `transform = "..."` | `raw_u8`, `raw_u16_be/le`, `raw_i16_be/le`, `scaled_100`, `scaled_1000` (signed ÷100/÷1000), `bcd_byte` — `format` covers all of these |
| GPS (UART lines) | `parse = "..."` | `nmea_gga_lat`, `nmea_gga_lon`, `nmea_gga_alt`, `nmea_gga_fix`, `nmea_rmc_speed` |
| Screens | `[display] controller` | SSD1306 and SH1106 with a built-in 5×7 font, detected at start-up |
| SPI fields | `rx_len`, `bit_mask`, `bit_shift`, `scale`, `transform = "twos_complement_N"` | as used by `max31855` |

Not supported yet: a second address (`addr_alt` is ignored), multi-byte or
timed start-up sequences, and `min_flash_kb` / `targets` (informational only).

## Included modules

| Module | Interface | Reads |
|--------|-----------|-------|
| `bmp280` | I2C | `temp` (°C), `pressure` (hPa) |
| `ds3231` | I2C | `time`, `date` |
| `mpu6050` | I2C | `accel_x/y/z` (g), `gyro_x/y/z` (°/s) |
| `max31855` | SPI | thermocouple temperature |
| `gps_nmea` | UART | `latitude`, `longitude`, `altitude`, `fix`, `speed` |
| `hc05` | UART | Bluetooth serial |
| `oled` | Display | any SSD1306 / SH1106 I2C OLED, detected |
| `ssd1306`, `ssd1306_32`, `sh1106` | Display | one specific screen |
