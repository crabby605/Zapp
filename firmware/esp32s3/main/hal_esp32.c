#include "hal.h"
#include "config.h"

#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/ledc.h"
#include "driver/rmt_tx.h"
#include "driver/spi_master.h"
#include "driver/uart.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define I2C_TIMEOUT_MS 100

// Servo pulse widths — trim these if your servo doesn't reach its end stops.
#define SERVO_MIN_US    1000   // -90 degrees
#define SERVO_MAX_US    2000   // +90 degrees
#define SERVO_PERIOD_US 20000  // 50 Hz frame

enum { PIN_UNSET, PIN_IN, PIN_OUT, PIN_PWM };
static uint8_t pin_mode[ZAPP_GPIO_COUNT];

void hal_board_init(void) {
}

void hal_gpio_set_output(uint8_t pin) {
    if (pin >= ZAPP_GPIO_COUNT || pin_mode[pin] == PIN_OUT) return;
    gpio_reset_pin(pin);
    gpio_set_direction(pin, GPIO_MODE_INPUT_OUTPUT);   // input too, so it can be read back
    pin_mode[pin] = PIN_OUT;
}

void hal_gpio_set_input(uint8_t pin) {
    if (pin >= ZAPP_GPIO_COUNT || pin_mode[pin] == PIN_IN) return;
    gpio_reset_pin(pin);   // leaves the pull-up on, which suits buttons to ground
    gpio_set_direction(pin, GPIO_MODE_INPUT);
    pin_mode[pin] = PIN_IN;
}

void hal_gpio_write(uint8_t pin, bool state) {
    gpio_set_level(pin, state);
}

bool hal_gpio_read(uint8_t pin) {
    return gpio_get_level(pin);
}

// PWM and servos on LEDC: 8 channels, one per pin. Plain PWM shares timer 0,
// servos share timer 1 at 50Hz.
//
// ponytail: every PWM pin runs at the last frequency asked for, because they
// share a timer. Give each frequency its own timer (LEDC has 4) if a program
// mixes them.
#define PWM_TIMER   LEDC_TIMER_0
#define SERVO_TIMER LEDC_TIMER_1
#define SERVO_BITS  LEDC_TIMER_14_BIT

static uint8_t pin_channel[ZAPP_GPIO_COUNT];   // channel + 1, 0 = none
static uint8_t channels_used;
static ledc_timer_t channel_timer[LEDC_CHANNEL_MAX];
static uint32_t timer_freq[2];
static ledc_timer_bit_t timer_bits[2];

static bool pwm_timer(ledc_timer_t timer, uint32_t freq_hz, ledc_timer_bit_t bits) {
    if (timer_freq[timer] == freq_hz && timer_bits[timer] == bits) return true;
    ledc_timer_config_t c = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .timer_num = timer,
        .duty_resolution = bits,
        .freq_hz = freq_hz,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    if (ledc_timer_config(&c) != ESP_OK) {
        hal_debug_println("Hardware Error: that PWM frequency is out of range");
        return false;
    }
    timer_freq[timer] = freq_hz;
    timer_bits[timer] = bits;
    return true;
}

static void pwm_output(uint8_t pin, ledc_timer_t timer, uint32_t duty) {
    if (pin >= ZAPP_GPIO_COUNT) return;
    if (!pin_channel[pin]) {
        if (channels_used >= LEDC_CHANNEL_MAX) {
            hal_debug_println("Hardware Error: only 8 pins can do PWM at once");
            return;
        }
        pin_channel[pin] = ++channels_used;
    }
    ledc_channel_t ch = (ledc_channel_t)(pin_channel[pin] - 1);

    if (pin_mode[pin] == PIN_PWM && channel_timer[ch] == timer) {
        ledc_set_duty(LEDC_LOW_SPEED_MODE, ch, duty);
        ledc_update_duty(LEDC_LOW_SPEED_MODE, ch);
        return;
    }
    ledc_channel_config_t c = {
        .gpio_num = pin,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = ch,
        .timer_sel = timer,
        .duty = duty,
    };
    ledc_channel_config(&c);
    channel_timer[ch] = timer;
    pin_mode[pin] = PIN_PWM;
}

void hal_pwm_set(uint8_t pin, uint8_t duty, uint32_t freq_hz) {
    if (freq_hz == 0) freq_hz = 1000;
    // Finer duty steps at low frequencies; the 80MHz clock caps bits x freq.
    ledc_timer_bit_t bits = freq_hz <= 5000 ? LEDC_TIMER_13_BIT
                          : freq_hz <= 40000 ? LEDC_TIMER_10_BIT : LEDC_TIMER_8_BIT;
    if (!pwm_timer(PWM_TIMER, freq_hz, bits)) return;
    uint32_t max = 1u << bits;
    pwm_output(pin, PWM_TIMER, max * duty / 255);
}

void hal_pwm_disable(uint8_t pin) {
    if (pin >= ZAPP_GPIO_COUNT || !pin_channel[pin]) return;
    ledc_stop(LEDC_LOW_SPEED_MODE, (ledc_channel_t)(pin_channel[pin] - 1), 0);
    pin_mode[pin] = PIN_UNSET;
    hal_gpio_set_output(pin);
    hal_gpio_write(pin, 0);
}

void hal_servo_set(uint8_t pin, int16_t angle) {
    if (angle < -90) angle = -90;
    if (angle >  90) angle =  90;
    uint32_t pulse_us = SERVO_MIN_US +
        ((uint32_t)(angle + 90) * (SERVO_MAX_US - SERVO_MIN_US)) / 180;
    if (!pwm_timer(SERVO_TIMER, 1000000 / SERVO_PERIOD_US, SERVO_BITS)) return;
    pwm_output(pin, SERVO_TIMER, pulse_us * (1u << SERVO_BITS) / SERVO_PERIOD_US);
}

// I2C: one bus. The new driver wants a handle per device address, so the
// last few are kept.
#define I2C_DEVICES 8

static i2c_master_bus_handle_t i2c_bus;
static uint32_t i2c_freq;
static struct { uint8_t addr; i2c_master_dev_handle_t dev; } i2c_devs[I2C_DEVICES];
static uint8_t i2c_dev_count, i2c_dev_next;

void hal_i2c_init(uint8_t sda, uint8_t scl, uint32_t freq_hz) {
    if (i2c_bus) {
        for (uint8_t i = 0; i < i2c_dev_count; i++) i2c_master_bus_rm_device(i2c_devs[i].dev);
        i2c_dev_count = i2c_dev_next = 0;
        i2c_del_master_bus(i2c_bus);
        i2c_bus = NULL;
    }
    i2c_master_bus_config_t c = {
        .i2c_port = -1,
        .sda_io_num = sda,
        .scl_io_num = scl,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    if (i2c_new_master_bus(&c, &i2c_bus) != ESP_OK) {
        i2c_bus = NULL;
        hal_debug_println("Hardware Error: I2C could not start on those pins");
        return;
    }
    i2c_freq = freq_hz ? freq_hz : 100000;
    pin_mode[sda] = pin_mode[scl] = PIN_UNSET;
}

static i2c_master_dev_handle_t i2c_dev(uint8_t addr) {
    if (!i2c_bus) return NULL;
    for (uint8_t i = 0; i < i2c_dev_count; i++)
        if (i2c_devs[i].addr == addr) return i2c_devs[i].dev;

    uint8_t slot;
    if (i2c_dev_count < I2C_DEVICES) {
        slot = i2c_dev_count++;
    } else {
        slot = i2c_dev_next++ % I2C_DEVICES;
        if (i2c_devs[slot].dev) i2c_master_bus_rm_device(i2c_devs[slot].dev);
    }
    i2c_device_config_t d = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = i2c_freq,
    };
    if (i2c_master_bus_add_device(i2c_bus, &d, &i2c_devs[slot].dev) != ESP_OK) {
        i2c_devs[slot].dev = NULL;
        i2c_devs[slot].addr = 0;   // general-call address: never looked up
        return NULL;
    }
    i2c_devs[slot].addr = addr;
    return i2c_devs[slot].dev;
}

bool hal_i2c_write(uint8_t addr, const uint8_t *data, size_t len) {
    i2c_master_dev_handle_t dev = i2c_dev(addr);
    return dev && len && i2c_master_transmit(dev, data, len, I2C_TIMEOUT_MS) == ESP_OK;
}

bool hal_i2c_read(uint8_t addr, uint8_t *buf, size_t len) {
    i2c_master_dev_handle_t dev = i2c_dev(addr);
    return dev && len && i2c_master_receive(dev, buf, len, I2C_TIMEOUT_MS) == ESP_OK;
}

bool hal_i2c_write_reg(uint8_t addr, uint8_t reg, const uint8_t *data, size_t len) {
    if (len > 15) return false;
    uint8_t buffer[16];  // reg byte + up to 15 data bytes
    buffer[0] = reg;
    memcpy(buffer + 1, data, len);
    return hal_i2c_write(addr, buffer, len + 1);
}

bool hal_i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *buf, size_t len) {
    i2c_master_dev_handle_t dev = i2c_dev(addr);
    return dev && len && i2c_master_transmit_receive(dev, &reg, 1, buf, len, I2C_TIMEOUT_MS) == ESP_OK;
}

void hal_i2c_scan(uint8_t *found, uint8_t *count) {
    *count = 0;
    if (!i2c_bus) return;
    for (uint8_t addr = 1; addr < 128; addr++) {
        if (i2c_master_probe(i2c_bus, addr, 10) == ESP_OK) found[(*count)++] = addr;
    }
}

// SPI on SPI2. Chip selects are plain GPIOs so any pin can be one.
static spi_device_handle_t spi_dev;
static bool spi_bus_up;

void hal_spi_init(uint8_t mosi, uint8_t miso, uint8_t sck, uint8_t cs,
                  uint32_t freq_hz, uint8_t mode) {
    if (spi_dev) { spi_bus_remove_device(spi_dev); spi_dev = NULL; }
    if (spi_bus_up) { spi_bus_free(SPI2_HOST); spi_bus_up = false; }

    spi_bus_config_t bus = {
        .mosi_io_num = mosi,
        .miso_io_num = miso,
        .sclk_io_num = sck,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 256,
    };
    if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_DISABLED) != ESP_OK) {
        hal_debug_println("Hardware Error: SPI could not start on those pins");
        return;
    }
    spi_bus_up = true;
    spi_device_interface_config_t dev = {
        .clock_speed_hz = freq_hz ? (int)freq_hz : 1000000,
        .mode = mode & 3,
        .spics_io_num = -1,
        .queue_size = 1,
    };
    spi_bus_add_device(SPI2_HOST, &dev, &spi_dev);
    pin_mode[mosi] = pin_mode[miso] = pin_mode[sck] = PIN_UNSET;
    if (cs < ZAPP_GPIO_COUNT) {   // 0xFF: no default chip select, programs name one per call
        hal_gpio_set_output(cs);
        hal_gpio_write(cs, 1);    // ponytail: chip-select is active-low only
    }
}

static void spi_run(const uint8_t *tx, uint8_t *rx, size_t len) {
    spi_transaction_t t = { .length = len * 8, .tx_buffer = tx, .rx_buffer = rx };
    spi_device_polling_transmit(spi_dev, &t);
}

bool hal_spi_exchange(uint8_t cs_pin, const uint8_t *tx, uint8_t *rx, uint8_t len) {
    if (!spi_dev || cs_pin >= ZAPP_GPIO_COUNT) return false;
    hal_gpio_set_output(cs_pin);
    hal_gpio_write(cs_pin, 0);
    spi_run(tx, rx, len);
    hal_gpio_write(cs_pin, 1);
    return true;
}

void hal_spi_cs_set(uint8_t cs_pin, bool active) {
    hal_gpio_write(cs_pin, !active);  // active-low
}

void hal_spi_transfer(uint8_t cs_pin, const uint8_t *tx, uint8_t tx_len,
                      uint8_t *rx, uint8_t rx_len) {
    static const uint8_t zeros[256];
    if (!spi_dev) return;
    hal_gpio_write(cs_pin, 0);
    if (tx_len > 0) spi_run(tx, NULL, tx_len);
    if (rx_len > 0) spi_run(zeros, rx, rx_len);
    hal_gpio_write(cs_pin, 1);
}

// UART1, any pins. The driver buffers RX in the background.
#define ZAPP_UART      UART_NUM_1
#define UART_RX_BUFFER 1024

static bool uart_ready = false;

static bool uart_rx_get(uint8_t *out, uint64_t deadline, volatile bool *halt_flag) {
    while (uart_read_bytes(ZAPP_UART, out, 1, pdMS_TO_TICKS(5)) != 1) {
        if (halt_flag && *halt_flag) return false;
        if (hal_time_us() >= deadline) return false;
    }
    return true;
}

void hal_uart_init(uint8_t tx, uint8_t rx, uint32_t baud, uint8_t bits, uint8_t parity, uint8_t stop) {
    if (uart_ready) uart_driver_delete(ZAPP_UART);
    if (bits < 5 || bits > 8) bits = 8;
    uart_config_t c = {
        .baud_rate = (int)baud,
        .data_bits = (uart_word_length_t)(UART_DATA_5_BITS + (bits - 5)),
        .parity = parity == 1 ? UART_PARITY_ODD : parity == 2 ? UART_PARITY_EVEN : UART_PARITY_DISABLE,
        .stop_bits = stop == 2 ? UART_STOP_BITS_2 : UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    uart_ready = uart_driver_install(ZAPP_UART, UART_RX_BUFFER, 0, 0, NULL, 0) == ESP_OK &&
                 uart_param_config(ZAPP_UART, &c) == ESP_OK &&
                 uart_set_pin(ZAPP_UART, tx, rx, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) == ESP_OK;
    if (!uart_ready) hal_debug_println("Hardware Error: UART could not start on those pins");
    pin_mode[tx] = pin_mode[rx] = PIN_UNSET;
}

void hal_uart_write(const uint8_t *data, size_t len) {
    if (!uart_ready || !data || len == 0) return;
    uart_write_bytes(ZAPP_UART, data, len);
}

uint8_t hal_uart_read_bytes(uint8_t *buf, uint8_t max_len, uint32_t timeout_ms, volatile bool *halt_flag) {
    if (!uart_ready || !buf || max_len == 0) return 0;

    uint8_t count = 0;
    uint64_t deadline = hal_time_us() + (uint64_t)timeout_ms * 1000;

    while (count < max_len && uart_rx_get(&buf[count], deadline, halt_flag)) {
        count++;
    }
    return count;
}

bool hal_uart_read_line(char *buf, uint8_t max_len, uint32_t timeout_ms, volatile bool *halt_flag) {
    if (!uart_ready || !buf || max_len < 2) return false;

    uint8_t pos = 0;
    uint64_t deadline = hal_time_us() + (uint64_t)timeout_ms * 1000;
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
    if (!uart_ready || !buf || max_len < 2) return false;

    uint8_t pos = 0;
    uint64_t deadline = hal_time_us() + (uint64_t)timeout_ms * 1000;
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
    if (!uart_ready) return 0;
    size_t n = 0;
    uart_get_buffered_data_len(ZAPP_UART, &n);
    return n > 0xFFFF ? 0xFFFF : (uint16_t)n;
}

void hal_uart_flush(void) {
    if (!uart_ready) return;
    uart_wait_tx_done(ZAPP_UART, pdMS_TO_TICKS(100));
    uart_flush_input(ZAPP_UART);
}

// ADC1 is GPIO1-10, ADC2 is GPIO11-20. ADC2 shares hardware with Wi-Fi, so
// its reads can fail while the radio is busy. Voltages go through the chip's
// factory calibration when it has one.
static adc_oneshot_unit_handle_t adc_units[2];
static adc_cali_handle_t adc_cali[2];
static uint32_t adc_pins_ready;

void hal_adc_init(uint8_t pin) {
    adc_unit_t unit;
    adc_channel_t chan;
    if (pin >= 32 || (adc_pins_ready & (1u << pin))) return;
    if (adc_oneshot_io_to_channel(pin, &unit, &chan) != ESP_OK) return;

    if (!adc_units[unit]) {
        adc_oneshot_unit_init_cfg_t u = { .unit_id = unit };
        if (adc_oneshot_new_unit(&u, &adc_units[unit]) != ESP_OK) { adc_units[unit] = NULL; return; }
        adc_cali_curve_fitting_config_t cali = {
            .unit_id = unit,
            .atten = ADC_ATTEN_DB_12,
            .bitwidth = ADC_BITWIDTH_12,
        };
        if (adc_cali_create_scheme_curve_fitting(&cali, &adc_cali[unit]) != ESP_OK) adc_cali[unit] = NULL;
    }
    adc_oneshot_chan_cfg_t c = { .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12 };
    if (adc_oneshot_config_channel(adc_units[unit], chan, &c) == ESP_OK) {
        adc_pins_ready |= 1u << pin;
        pin_mode[pin] = PIN_UNSET;
    }
}

static int adc_raw(uint8_t pin, adc_unit_t *unit) {
    adc_channel_t chan;
    int raw = 0;
    if (pin >= 32 || !(adc_pins_ready & (1u << pin))) return 0;
    adc_oneshot_io_to_channel(pin, unit, &chan);
    if (adc_oneshot_read(adc_units[*unit], chan, &raw) != ESP_OK) return 0;
    return raw;
}

uint16_t hal_adc_read_raw(uint8_t pin) {
    adc_unit_t unit;
    return (uint16_t)(adc_raw(pin, &unit) << 4);   // 12-bit sample scaled to 0-65535
}

float hal_adc_read_voltage(uint8_t pin) {
    adc_unit_t unit = ADC_UNIT_1;
    int raw = adc_raw(pin, &unit), mv = 0;
    if (adc_cali[unit] && adc_cali_raw_to_voltage(adc_cali[unit], raw, &mv) == ESP_OK) return (float)mv / 1000.0f;
    return (float)raw * 3.1f / 4095.0f;   // uncalibrated: 12dB attenuation tops out near 3.1V
}

void hal_sleep_us(uint32_t us) {
    esp_rom_delay_us(us);
}

void hal_sleep_ms(uint32_t ms) {
    vTaskDelay(pdMS_TO_TICKS(ms));
}

uint64_t hal_time_us(void) {
    return (uint64_t)esp_timer_get_time();
}

// NeoPixel on the RMT peripheral: each byte becomes 8 WS2812 bit pulses at a
// 10MHz tick (0.3us/0.9us high for a 0/1 bit).
//
// ponytail: one strip on one pin, 64 pixels max — the common case. A second
// strip needs a second RMT channel and a per-pin lookup.
#define NEO_MAX_PIXELS 64

static struct {
    rmt_channel_handle_t chan;
    rmt_encoder_handle_t encoder;
    uint16_t count;
    uint8_t  brightness;
    uint8_t  px[NEO_MAX_PIXELS * 3];   // GRB order, as WS2812 expects
} neo = { .brightness = 255 };

void hal_neopixel_init(uint8_t pin, uint16_t count) {
    if (count > NEO_MAX_PIXELS) count = NEO_MAX_PIXELS;
    neo.count = count;
    if (neo.chan) return;

    rmt_tx_channel_config_t c = {
        .gpio_num = pin,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10000000,
        .mem_block_symbols = 64,
        .trans_queue_depth = 1,
    };
    rmt_bytes_encoder_config_t e = {
        .bit0 = { .level0 = 1, .duration0 = 3, .level1 = 0, .duration1 = 9 },
        .bit1 = { .level0 = 1, .duration0 = 9, .level1 = 0, .duration1 = 3 },
        .flags.msb_first = 1,
    };
    if (rmt_new_tx_channel(&c, &neo.chan) != ESP_OK ||
        rmt_new_bytes_encoder(&e, &neo.encoder) != ESP_OK ||
        rmt_enable(neo.chan) != ESP_OK) {
        neo.chan = NULL;
        hal_debug_println("Hardware Error: NeoPixel could not start on that pin");
        return;
    }
    pin_mode[pin] = PIN_UNSET;
}

void hal_neopixel_set(uint8_t pin, uint16_t index, uint8_t r, uint8_t g, uint8_t b) {
    if (!neo.chan) hal_neopixel_init(pin, NEO_MAX_PIXELS);
    if (index >= neo.count) return;
    neo.px[index * 3 + 0] = g;
    neo.px[index * 3 + 1] = r;
    neo.px[index * 3 + 2] = b;
}

void hal_neopixel_set_all(uint8_t pin, uint8_t r, uint8_t g, uint8_t b) {
    if (!neo.chan) hal_neopixel_init(pin, NEO_MAX_PIXELS);
    for (uint16_t i = 0; i < neo.count; i++) {
        hal_neopixel_set(pin, i, r, g, b);
    }
}

void hal_neopixel_brightness(uint8_t pin, uint8_t brightness) {
    (void)pin;
    neo.brightness = brightness;
}

void hal_neopixel_show(uint8_t pin) {
    if (!neo.chan) hal_neopixel_init(pin, NEO_MAX_PIXELS);
    if (!neo.chan) return;
    static uint8_t frame[NEO_MAX_PIXELS * 3];
    size_t n = (size_t)neo.count * 3;
    for (size_t i = 0; i < n; i++) frame[i] = (uint8_t)((uint32_t)neo.px[i] * neo.brightness / 255);
    rmt_transmit_config_t t = { .loop_count = 0 };
    rmt_transmit(neo.chan, neo.encoder, frame, n, &t);
    rmt_tx_wait_all_done(neo.chan, 100);
    esp_rom_delay_us(60);   // WS2812 latch/reset gap
}
