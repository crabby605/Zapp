#include "hal.h"
#include "uart_ring.h"
#include "pico/stdlib.h"
#include "hardware/adc.h"
#include "hardware/clocks.h"
#include "hardware/i2c.h"
#include "hardware/irq.h"
#include "hardware/pio.h"
#include "hardware/pwm.h"
#include "hardware/spi.h"
#include "hardware/uart.h"
#include "ws2812.pio.h"
#include <stdio.h>

#define I2C_TIMEOUT_US 100000  // 100ms per I2C operation

// Servo pulse widths — trim these if your servo doesn't reach its end stops.
#define SERVO_MIN_US    1000   // -90 degrees
#define SERVO_MAX_US    2000   // +90 degrees
#define SERVO_PERIOD_US 20000  // 50 Hz frame

static i2c_inst_t *zapp_i2c = i2c0;
static bool zapp_i2c_ready = false;

static spi_inst_t *zapp_spi = spi0;
static bool zapp_spi_ready = false;

static uart_inst_t *zapp_uart = uart0;
static bool zapp_uart_ready = false;

void hal_board_init(void) {
}

void hal_gpio_set_output(uint8_t pin) {
    gpio_init(pin);
    gpio_set_dir(pin, GPIO_OUT);
}

void hal_gpio_set_input(uint8_t pin) {
    gpio_init(pin);
    gpio_set_dir(pin, GPIO_IN);
}

void hal_gpio_write(uint8_t pin, bool state) {
    gpio_put(pin, state);
}

bool hal_gpio_read(uint8_t pin) {
    return gpio_get(pin);
}

void hal_pwm_set(uint8_t pin, uint8_t duty, uint32_t freq_hz) {
    if (freq_hz == 0) freq_hz = 1000;
    gpio_set_function(pin, GPIO_FUNC_PWM);
    uint slice = pwm_gpio_to_slice_num(pin);

    // Pick the smallest divider that keeps `wrap` inside 16 bits.
    float clk = (float)clock_get_hz(clk_sys);
    float divider = clk / (freq_hz * 65536.0f);
    if (divider < 1.0f) divider = 1.0f;
    uint32_t wrap = (uint32_t)(clk / (divider * (float)freq_hz)) - 1;
    if (wrap > 65535) wrap = 65535;

    pwm_set_clkdiv(slice, divider);
    pwm_set_wrap(slice, (uint16_t)wrap);
    pwm_set_chan_level(slice, pwm_gpio_to_channel(pin),
                       (uint16_t)((wrap + 1) * duty / 255));
    pwm_set_enabled(slice, true);
}

void hal_pwm_disable(uint8_t pin) {
    // ponytail: disables the whole slice, so it also stops the paired GPIO.
    // Track per-channel state if two PWM pins ever share a slice.
    pwm_set_enabled(pwm_gpio_to_slice_num(pin), false);
    gpio_set_function(pin, GPIO_FUNC_SIO);
    gpio_set_dir(pin, GPIO_OUT);
    gpio_put(pin, 0);
}

void hal_servo_set(uint8_t pin, int16_t angle) {
    if (angle < -90) angle = -90;
    if (angle >  90) angle =  90;
    uint32_t pulse_us = SERVO_MIN_US +
        ((uint32_t)(angle + 90) * (SERVO_MAX_US - SERVO_MIN_US)) / 180;

    gpio_set_function(pin, GPIO_FUNC_PWM);
    uint slice = pwm_gpio_to_slice_num(pin);
    pwm_set_clkdiv(slice, (float)clock_get_hz(clk_sys) / 1000000.0f);  // 1 tick = 1us
    pwm_set_wrap(slice, SERVO_PERIOD_US - 1);
    pwm_set_chan_level(slice, pwm_gpio_to_channel(pin), (uint16_t)pulse_us);
    pwm_set_enabled(slice, true);
}

void hal_i2c_init(uint8_t sda, uint8_t scl, uint32_t freq_hz) {
    zapp_i2c = ((sda / 2) % 2 == 0) ? i2c0 : i2c1;
    i2c_init(zapp_i2c, freq_hz);
    gpio_set_function(sda, GPIO_FUNC_I2C);
    gpio_set_function(scl, GPIO_FUNC_I2C);
    gpio_pull_up(sda);
    gpio_pull_up(scl);
    zapp_i2c_ready = true;
}

bool hal_i2c_write(uint8_t addr, const uint8_t *data, size_t len) {
    if (!zapp_i2c_ready || len == 0) return false;
    return i2c_write_timeout_us(zapp_i2c, addr, data, len, false, I2C_TIMEOUT_US) == (int)len;
}

bool hal_i2c_read(uint8_t addr, uint8_t *buf, size_t len) {
    if (!zapp_i2c_ready || len == 0) return false;
    return i2c_read_timeout_us(zapp_i2c, addr, buf, len, false, I2C_TIMEOUT_US) == (int)len;
}

bool hal_i2c_write_reg(uint8_t addr, uint8_t reg, const uint8_t *data, size_t len) {
    if (!zapp_i2c_ready || len > 15) return false;
    uint8_t buffer[16];  // reg byte + up to 15 data bytes
    buffer[0] = reg;
    for (size_t i = 0; i < len; i++) {
        buffer[i + 1] = data[i];
    }
    return i2c_write_timeout_us(zapp_i2c, addr, buffer, len + 1, false, I2C_TIMEOUT_US) == (int)(len + 1);
}

bool hal_i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *buf, size_t len) {
    if (!zapp_i2c_ready || len == 0) return false;
    if (i2c_write_timeout_us(zapp_i2c, addr, &reg, 1, true, I2C_TIMEOUT_US) != 1) return false;
    return i2c_read_timeout_us(zapp_i2c, addr, buf, len, false, I2C_TIMEOUT_US) == (int)len;
}

void hal_i2c_scan(uint8_t *found, uint8_t *count) {
    *count = 0;
    if (!zapp_i2c_ready) return;
    uint8_t rxdata;
    for (uint8_t addr = 1; addr < 128; addr++) {
        if (*count >= 127) break;  // bounds safety
        int ret = i2c_read_timeout_us(zapp_i2c, addr, &rxdata, 1, false, 10000);
        if (ret >= 0) {
            found[(*count)++] = addr;
        }
    }
}

void hal_spi_init(uint8_t mosi, uint8_t miso, uint8_t sck, uint8_t cs,
                  uint32_t freq_hz, uint8_t mode) {
    // spi0 SCK lives on GP2/6/18/22, spi1 SCK on GP10/14/26 — bit 3 separates them.
    zapp_spi = ((sck >> 3) & 1) ? spi1 : spi0;
    spi_init(zapp_spi, freq_hz ? freq_hz : 1000000);
    spi_set_format(zapp_spi, 8,
                   (mode & 2) ? SPI_CPOL_1 : SPI_CPOL_0,
                   (mode & 1) ? SPI_CPHA_1 : SPI_CPHA_0,
                   SPI_MSB_FIRST);
    gpio_set_function(mosi, GPIO_FUNC_SPI);
    gpio_set_function(miso, GPIO_FUNC_SPI);
    gpio_set_function(sck,  GPIO_FUNC_SPI);
    if (cs < 30) {              // 0xFF: no default chip select, programs name one per call
        gpio_init(cs);
        gpio_set_dir(cs, GPIO_OUT);
        gpio_put(cs, 1);        // ponytail: chip-select is active-low only
    }
    zapp_spi_ready = true;
}

bool hal_spi_exchange(uint8_t cs_pin, const uint8_t *tx, uint8_t *rx, uint8_t len) {
    static uint32_t cs_ready;   // pins already set up as chip selects
    if (!zapp_spi_ready || cs_pin >= 30) return false;
    if (!(cs_ready & (1u << cs_pin))) {
        gpio_init(cs_pin);
        gpio_set_dir(cs_pin, GPIO_OUT);
        cs_ready |= 1u << cs_pin;
    }
    gpio_put(cs_pin, 0);
    spi_write_read_blocking(zapp_spi, tx, rx, len);
    gpio_put(cs_pin, 1);
    return true;
}

void hal_spi_cs_set(uint8_t cs_pin, bool active) {
    gpio_put(cs_pin, !active);  // active-low
}

void hal_spi_transfer(uint8_t cs_pin, const uint8_t *tx, uint8_t tx_len,
                      uint8_t *rx, uint8_t rx_len) {
    if (!zapp_spi_ready) return;
    gpio_put(cs_pin, 0);
    if (tx_len > 0) spi_write_blocking(zapp_spi, tx, tx_len);
    if (rx_len > 0) spi_read_blocking(zapp_spi, 0x00, rx, rx_len);
    gpio_put(cs_pin, 1);
}

// RX is interrupt-driven into a ring buffer: bytes that arrive between reads
// are kept instead of being lost to the 32-byte hardware FIFO, and
// hal_uart_available() can report a real count.
static UartRing uart_rx;
static int uart_rx_irq = -1;

static void uart_rx_isr(void) {
    while (uart_is_readable(zapp_uart)) {
        uart_ring_push(&uart_rx, (uint8_t)uart_getc(zapp_uart));
    }
}

// Pop one buffered byte, waiting until the deadline (or a halt request).
static bool uart_rx_get(uint8_t *out, uint64_t deadline, volatile bool *halt_flag) {
    while (!uart_ring_pop(&uart_rx, out)) {
        if (halt_flag && *halt_flag) return false;
        if (time_us_64() >= deadline) return false;
        sleep_us(100);
    }
    return true;
}

void hal_uart_init(uint8_t tx, uint8_t rx, uint32_t baud, uint8_t bits, uint8_t parity, uint8_t stop) {
    // RP2040 UART instance selection from TX pin:
    // uart0 TX on GP0,12,16,28 — uart1 TX on GP4,8,20,24
    zapp_uart = (((tx >> 2) & 1) ^ ((tx >> 3) & 1)) ? uart1 : uart0;

    uart_init(zapp_uart, baud);
    gpio_set_function(tx, GPIO_FUNC_UART);
    gpio_set_function(rx, GPIO_FUNC_UART);

    uart_parity_t p = UART_PARITY_NONE;
    if (parity == 1) p = UART_PARITY_ODD;
    else if (parity == 2) p = UART_PARITY_EVEN;

    uart_set_format(zapp_uart, bits, stop, p);
    uart_set_fifo_enabled(zapp_uart, true);

    uart_ring_init(&uart_rx);
    int irq = (zapp_uart == uart0) ? UART0_IRQ : UART1_IRQ;
    if (uart_rx_irq >= 0 && uart_rx_irq != irq) {
        irq_set_enabled(uart_rx_irq, false);
        irq_remove_handler(uart_rx_irq, uart_rx_isr);
        uart_rx_irq = -1;
    }
    if (uart_rx_irq != irq) {
        irq_set_exclusive_handler(irq, uart_rx_isr);
        irq_set_enabled(irq, true);
        uart_rx_irq = irq;
    }
    uart_set_irq_enables(zapp_uart, true, false);   // RX only
    zapp_uart_ready = true;
}

void hal_uart_write(const uint8_t *data, size_t len) {
    if (!zapp_uart_ready || !data || len == 0) return;
    uart_write_blocking(zapp_uart, data, len);
}

uint8_t hal_uart_read_bytes(uint8_t *buf, uint8_t max_len, uint32_t timeout_ms, volatile bool *halt_flag) {
    if (!zapp_uart_ready || !buf || max_len == 0) return 0;

    uint8_t count = 0;
    uint64_t deadline = time_us_64() + (uint64_t)timeout_ms * 1000;

    while (count < max_len && uart_rx_get(&buf[count], deadline, halt_flag)) {
        count++;
    }
    return count;
}

bool hal_uart_read_line(char *buf, uint8_t max_len, uint32_t timeout_ms, volatile bool *halt_flag) {
    if (!zapp_uart_ready || !buf || max_len < 2) return false;

    uint8_t pos = 0;
    uint64_t deadline = time_us_64() + (uint64_t)timeout_ms * 1000;
    uint8_t c;

    while (pos < max_len - 1 && uart_rx_get(&c, deadline, halt_flag)) {
        if (c == '\n') {
            buf[pos] = '\0';
            return true;
        }
        if (c != '\r') buf[pos++] = (char)c;
    }
    buf[pos] = '\0';
    return false;
}

bool hal_uart_read_until(char *buf, uint8_t max_len, uint8_t terminator, uint32_t timeout_ms, volatile bool *halt_flag) {
    if (!zapp_uart_ready || !buf || max_len < 2) return false;

    uint8_t pos = 0;
    uint64_t deadline = time_us_64() + (uint64_t)timeout_ms * 1000;
    uint8_t c;

    while (pos < max_len - 1 && uart_rx_get(&c, deadline, halt_flag)) {
        if (c == terminator) {
            buf[pos] = '\0';
            return true;
        }
        buf[pos++] = (char)c;
    }
    buf[pos] = '\0';
    return false;
}

uint16_t hal_uart_available(void) {
    if (!zapp_uart_ready) return 0;
    return uart_ring_available(&uart_rx);
}

void hal_uart_flush(void) {
    if (!zapp_uart_ready) return;
    uart_tx_wait_blocking(zapp_uart);
    while (uart_is_readable(zapp_uart)) {
        uart_getc(zapp_uart);
    }
    uart_ring_flush(&uart_rx);
}

// RP2040 ADC inputs are GP26-29 (channels 0-3).
static bool adc_started = false;

void hal_adc_init(uint8_t pin) {
    if (pin < 26 || pin > 29) return;
    if (!adc_started) {
        adc_init();
        adc_started = true;
    }
    adc_gpio_init(pin);
}

uint16_t hal_adc_read_raw(uint8_t pin) {
    if (pin < 26 || pin > 29 || !adc_started) return 0;
    adc_select_input((uint)(pin - 26));
    return (uint16_t)(adc_read() << 4);   // 12-bit sample scaled to 0-65535
}

float hal_adc_read_voltage(uint8_t pin) {
    return (float)hal_adc_read_raw(pin) * 3.3f / 65535.0f;
}

void hal_sleep_us(uint32_t us) {
    sleep_us(us);
}

void hal_sleep_ms(uint32_t ms) {
    sleep_ms(ms);
}

uint64_t hal_time_us(void) {
    return time_us_64();
}

// ponytail: one strip on one pin, 64 pixels max — the common case. A second
// strip needs a second state machine and a per-pin lookup.
#define NEO_MAX_PIXELS 64

static struct {
    bool     ready;
    uint8_t  pin;
    uint     sm;
    uint     offset;
    uint16_t count;
    uint8_t  brightness;
    uint8_t  px[NEO_MAX_PIXELS * 3];   // GRB order, as WS2812 expects
} neo = { .brightness = 255 };

void hal_neopixel_init(uint8_t pin, uint16_t count) {
    if (count > NEO_MAX_PIXELS) count = NEO_MAX_PIXELS;
    neo.count = count;
    neo.pin = pin;
    if (neo.ready) return;

    neo.offset = (uint)pio_add_program(pio0, &ws2812_program);
    neo.sm = 0;
    pio_gpio_init(pio0, pin);
    pio_sm_set_consecutive_pindirs(pio0, neo.sm, pin, 1, true);

    pio_sm_config c = ws2812_program_get_default_config(neo.offset);
    sm_config_set_sideset_pins(&c, pin);
    sm_config_set_out_shift(&c, false, true, 24);   // MSB first, autopull at 24 bits
    sm_config_set_fifo_join(&c, PIO_FIFO_JOIN_TX);
    int cycles_per_bit = ws2812_T1 + ws2812_T2 + ws2812_T3;
    sm_config_set_clkdiv(&c, (float)clock_get_hz(clk_sys) / (800000.0f * cycles_per_bit));
    pio_sm_init(pio0, neo.sm, neo.offset, &c);
    pio_sm_set_enabled(pio0, neo.sm, true);
    neo.ready = true;
}

void hal_neopixel_set(uint8_t pin, uint16_t index, uint8_t r, uint8_t g, uint8_t b) {
    if (!neo.ready) hal_neopixel_init(pin, NEO_MAX_PIXELS);
    if (index >= neo.count) return;
    neo.px[index * 3 + 0] = g;
    neo.px[index * 3 + 1] = r;
    neo.px[index * 3 + 2] = b;
}

void hal_neopixel_set_all(uint8_t pin, uint8_t r, uint8_t g, uint8_t b) {
    if (!neo.ready) hal_neopixel_init(pin, NEO_MAX_PIXELS);
    for (uint16_t i = 0; i < neo.count; i++) {
        hal_neopixel_set(pin, i, r, g, b);
    }
}

void hal_neopixel_brightness(uint8_t pin, uint8_t brightness) {
    (void)pin;
    neo.brightness = brightness;
}

void hal_neopixel_show(uint8_t pin) {
    if (!neo.ready) hal_neopixel_init(pin, NEO_MAX_PIXELS);
    for (uint16_t i = 0; i < neo.count; i++) {
        uint32_t grb = 0;
        for (int c = 0; c < 3; c++) {
            grb = (grb << 8) | ((uint32_t)neo.px[i * 3 + c] * neo.brightness / 255);
        }
        pio_sm_put_blocking(pio0, neo.sm, grb << 8u);   // left-aligned 24 bits
    }
    sleep_us(60);   // WS2812 latch/reset gap
}
