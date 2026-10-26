#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

// Zapp HAL Interface
// All VM opcodes call through these functions.
// Swap hal_rp2040.c for hal_esp32.c to port to a new chip.

// Init
void hal_board_init(void);

// GPIO
void     hal_gpio_set_output(uint8_t pin);
void     hal_gpio_set_input(uint8_t pin);
void     hal_gpio_write(uint8_t pin, bool state);
bool     hal_gpio_read(uint8_t pin);

// PWM
// duty: 0-255 maps to 0-100%
// freq_hz: PWM frequency in Hz
void     hal_pwm_set(uint8_t pin, uint8_t duty, uint32_t freq_hz);
void     hal_pwm_disable(uint8_t pin);

// Servo
// angle: -90 to +90 degrees
// Implemented via PIO for cycle-accurate 50Hz pulse
void     hal_servo_set(uint8_t pin, int16_t angle);

// I2C
void     hal_i2c_init(uint8_t sda, uint8_t scl, uint32_t freq_hz);
bool     hal_i2c_write(uint8_t addr, const uint8_t *data, size_t len);
bool     hal_i2c_read(uint8_t addr, uint8_t *buf, size_t len);
bool     hal_i2c_write_reg(uint8_t addr, uint8_t reg, const uint8_t *data, size_t len);
bool     hal_i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *buf, size_t len);
void     hal_i2c_scan(uint8_t *found, uint8_t *count); // returns up to 127 addresses

// SPI
void     hal_spi_init(uint8_t mosi, uint8_t miso, uint8_t sck, uint8_t cs,
                      uint32_t freq_hz, uint8_t mode);
void     hal_spi_cs_set(uint8_t cs_pin, bool active);
void     hal_spi_transfer(uint8_t cs_pin,
                          const uint8_t *tx, uint8_t tx_len,
                          uint8_t *rx, uint8_t rx_len);
// Full duplex: clock out tx while clocking in rx, len bytes, with cs held low.
// cs can be any pin, so several chips share one bus. False if SPI isn't set up.
bool     hal_spi_exchange(uint8_t cs_pin, const uint8_t *tx, uint8_t *rx, uint8_t len);

// UART
void     hal_uart_init(uint8_t tx, uint8_t rx, uint32_t baud,
                       uint8_t bits, uint8_t parity, uint8_t stop);
void     hal_uart_write(const uint8_t *data, size_t len);
uint8_t  hal_uart_read_bytes(uint8_t *buf, uint8_t max_len, uint32_t timeout_ms, volatile bool *halt_flag);
bool     hal_uart_read_line(char *buf, uint8_t max_len, uint32_t timeout_ms, volatile bool *halt_flag);
bool     hal_uart_read_until(char *buf, uint8_t max_len,
                             uint8_t terminator, uint32_t timeout_ms, volatile bool *halt_flag);
uint16_t hal_uart_available(void);
void     hal_uart_flush(void);

// ADC
void     hal_adc_init(uint8_t pin);
uint16_t hal_adc_read_raw(uint8_t pin);    // 0-65535
float    hal_adc_read_voltage(uint8_t pin); // 0.0-3.3

// Timing
void     hal_sleep_us(uint32_t us);
void     hal_sleep_ms(uint32_t ms);
uint64_t hal_time_us(void);

// NeoPixel (PIO)
void     hal_neopixel_init(uint8_t pin, uint16_t count);
void     hal_neopixel_set(uint8_t pin, uint16_t index, uint8_t r, uint8_t g, uint8_t b);
void     hal_neopixel_set_all(uint8_t pin, uint8_t r, uint8_t g, uint8_t b);
void     hal_neopixel_brightness(uint8_t pin, uint8_t brightness);
void     hal_neopixel_show(uint8_t pin);

// HID (USB keyboard + mouse)
// The VM runs on the second core but TinyUSB is single-threaded, so these
// queue a report and hal_hid_pump() sends it from the USB loop.
void     hal_hid_key(uint8_t modifier, uint8_t keycode);
void     hal_hid_type(const char *text, uint8_t len);
void     hal_hid_mouse(int8_t dx, int8_t dy, uint8_t buttons, int8_t scroll);
void     hal_hid_pump(void);   // call from the USB core's main loop

// Debug
void     hal_debug_print(const char *s);
void     hal_debug_println(const char *s);

