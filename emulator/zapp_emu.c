// Zapp emulator — the real bytecode VM (src/vm.c) linked against a virtual
// board instead of the Pico SDK. Every hardware effect prints as one line, so
// programs can be tested on a laptop with no board attached.
//
//   make -C emulator            # builds emulator/zapp-emu
//   echo 'BC:011901...FF' | emulator/zapp-emu
//   emulator/zapp-emu --gpio 15=0 --quiet 'BC:...'
//
// Flags:
//   --gpio N=0|1   preset an input pin before the run
//   --quiet        hide I2C/SPI bus chatter, keep program output
//   --no-display   skip the framebuffer dump at exit
//   --no-radio     pretend the board has no radio (plain RP2040)
//   --fb           dump the final display framebuffer as "fb:<hex>" for tools
//   --display KIND[@3d]  which OLED is attached: ssd1306 (default), ssd1306_32,
//                  ssd1306_noread (a clone that ignores reads), sh1106 or none;
//                  @3d puts it at address 0x3D instead of 0x3C

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "hal.h"
#include "hal_radio.h"
#include "config.h"
#include "vm.h"

// Runaway `repeat forever` programs would never return, so the harness stops
// the VM after this much simulated time or this many printed lines.
#define SIM_TIME_LIMIT_US 5000000ull
#define PRINT_LIMIT       500

static uint64_t sim_now_us = 0;
static int      print_count = 0;
static bool     gpio_state[64];
static bool     quiet = false;
static bool     show_display = true;
static bool     dump_fb = false;

// Virtual OLED
// Behaves like the real chips closely enough to test the driver: it answers
// only at its address, reports the controller in its status byte (what the
// firmware's detection reads), and follows SSD1306 window addressing or SH1106
// page addressing with its 2-column RAM offset.
#define VD_WIDTH 128
#define VD_PAGES 8
typedef enum { VD_SSD1306, VD_SSD1306_32, VD_SSD1306_NOREAD, VD_SH1106, VD_NONE } VdKind;
static VdKind  vd_kind = VD_SSD1306;
static uint8_t vd_addr = 0x3C;
static uint8_t vd_fb[VD_PAGES][VD_WIDTH];
static int     vd_page = 0, vd_col = 0;               // write pointer (RAM column)
static int     vd_col_lo = 0, vd_col_hi = VD_WIDTH - 1, vd_page_lo = 0, vd_page_hi = VD_PAGES - 1;
static bool    vd_used = false;

static int vd_rows(void) { return vd_kind == VD_SSD1306_32 ? 32 : 64; }

static uint8_t vd_status(void) {
    // Bit 6 = display off; the low nibble identifies the chip.
    return 0x40 | (vd_kind == VD_SH1106 ? 0x08 : vd_kind == VD_SSD1306_32 ? 0x03 : 0x06);
}

static void vd_command(const uint8_t *c, size_t n) {
    for (size_t i = 0; i < n; i++) {
        uint8_t op = c[i];
        if (op == 0x21 && i + 2 < n)      { vd_col_lo = c[i + 1]; vd_col_hi = c[i + 2]; vd_col = vd_col_lo; i += 2; }
        else if (op == 0x22 && i + 2 < n) { vd_page_lo = c[i + 1] & 7; vd_page_hi = c[i + 2] & 7; vd_page = vd_page_lo; i += 2; }
        else if (op >= 0xB0 && op <= 0xB7) vd_page = op & 7;                       // page mode
        else if (op <= 0x0F)              vd_col = (vd_col & 0xF0) | op;           // column low nibble
        else if (op >= 0x10 && op <= 0x1F) vd_col = (vd_col & 0x0F) | ((op & 0x0F) << 4);
        else if (op == 0x20 || op == 0x81 || op == 0x8D || op == 0xA8 || op == 0xAD ||
                 op == 0xD3 || op == 0xD5 || op == 0xD9 || op == 0xDA || op == 0xDB) i++;   // one argument
    }
}

static void vd_data(const uint8_t *d, size_t n) {
    vd_used = true;
    for (size_t i = 0; i < n; i++) {
        int x = vd_kind == VD_SH1106 ? vd_col - 2 : vd_col;   // SH1106: 132-wide RAM, 128 visible
        if (x >= 0 && x < VD_WIDTH) vd_fb[vd_page][x] = d[i];
        if (vd_kind == VD_SH1106) {
            vd_col++;                                          // page mode: no wrap
        } else if (++vd_col > vd_col_hi) {                     // window mode: wrap to next page
            vd_col = vd_col_lo;
            if (++vd_page > vd_page_hi) vd_page = vd_page_lo;
        }
    }
}

// Machine-readable framebuffer: 1024 bytes, page-major, as the display holds it.
static void vd_dump(void) {
    if (!vd_used || !dump_fb) return;
    printf("fb:");
    for (int page = 0; page < VD_PAGES; page++) {
        for (int x = 0; x < VD_WIDTH; x++) printf("%02X", vd_fb[page][x]);
    }
    printf("\n");
}

// The screen as text, one character per pixel, trimmed to the rows in use.
static void vd_render(void) {
    if (!vd_used || !show_display) return;
    int last = -1;
    for (int y = 0; y < vd_rows(); y++)
        for (int x = 0; x < VD_WIDTH; x++)
            if ((vd_fb[y / 8][x] >> (y & 7)) & 1) last = y;
    printf("display:\n");
    for (int y = 0; y <= last; y++) {
        char row[VD_WIDTH + 1];
        for (int x = 0; x < VD_WIDTH; x++) row[x] = ((vd_fb[y / 8][x] >> (y & 7)) & 1) ? '#' : '.';
        row[VD_WIDTH] = '\0';
        printf("  %s\n", row);
    }
}

static void budget_check(void) {
    if (sim_now_us > SIM_TIME_LIMIT_US || print_count > PRINT_LIMIT) {
        vm_request_halt();
    }
}

void hal_init(void) {}

// GPIO
void hal_gpio_set_output(uint8_t pin) { (void)pin; }
void hal_gpio_set_input(uint8_t pin)  { (void)pin; }

void hal_gpio_write(uint8_t pin, bool state) {
    if (pin < 64) gpio_state[pin] = state;
    printf("gpio %u=%d\n", pin, state ? 1 : 0);
}

// Pin reads follow whatever was last written, defaulting to high so
// `read pin` has something deterministic to report.
bool hal_gpio_read(uint8_t pin) {
    return (pin < 64) ? gpio_state[pin] : true;
}

// PWM / servo / ADC
void hal_pwm_set(uint8_t pin, uint8_t duty, uint32_t freq_hz) {
    printf("pwm %u duty=%u freq=%u\n", pin, duty, (unsigned)freq_hz);
}
void hal_pwm_disable(uint8_t pin) { printf("pwm %u off\n", pin); }
void hal_servo_set(uint8_t pin, int16_t angle) { printf("servo %u=%d\n", pin, angle); }

void     hal_adc_init(uint8_t pin) { (void)pin; }
uint16_t hal_adc_read_raw(uint8_t pin) { (void)pin; return 32768; }
float    hal_adc_read_voltage(uint8_t pin) { (void)pin; return 1.65f; }

// I2C
// Register reads return a fixed ramp so transforms produce stable numbers.
void hal_i2c_init(uint8_t sda, uint8_t scl, uint32_t freq_hz) {
    if (!quiet) printf("i2c init sda=%u scl=%u freq=%u\n", sda, scl, (unsigned)freq_hz);
}

// 0x3C/0x3D belong to the OLED: only its own address acknowledges.
static bool vd_is_display_addr(uint8_t addr) { return addr == 0x3C || addr == 0x3D; }
static bool vd_present(uint8_t addr) { return vd_kind != VD_NONE && addr == vd_addr; }

bool hal_i2c_write(uint8_t addr, const uint8_t *data, size_t len) {
    if (len < 1) return true;
    if (vd_is_display_addr(addr)) {
        if (!vd_present(addr)) return false;
        if (data[0] == 0x40) vd_data(data + 1, len - 1);
        else if (data[0] == 0x00) vd_command(data + 1, len - 1);
        return true;
    }
    if (!quiet) printf("i2c write 0x%02X len=%u\n", addr, (unsigned)len);
    return true;
}

bool hal_i2c_read(uint8_t addr, uint8_t *buf, size_t len) {
    (void)addr;
    for (size_t i = 0; i < len; i++) buf[i] = (uint8_t)(i + 1);
    return true;
}

bool hal_i2c_write_reg(uint8_t addr, uint8_t reg, const uint8_t *data, size_t len) {
    if (!quiet) printf("i2c write 0x%02X reg=0x%02X len=%u\n", addr, reg, (unsigned)len);
    (void)data;
    return true;
}

// Virtual I2C devices
// Register reads answer as the real parts would, so programs behave the way
// they will on a bench: the clock returns the host's time, the barometer a room
// temperature, the accelerometer a board lying flat.

static uint8_t to_bcd(int value) {
    return (uint8_t)(((value / 10) << 4) | (value % 10));
}

// DS3231 (0x68, registers 0x00-0x12): seconds, minutes, hours, day, date,
// month, year — all BCD, exactly as the chip stores them.
static bool ds3231_read(uint8_t reg, uint8_t *buf, size_t len) {
    time_t now = time(NULL);
    struct tm *t = localtime(&now);
    uint8_t regs[7] = {
        to_bcd(t->tm_sec), to_bcd(t->tm_min), to_bcd(t->tm_hour),
        to_bcd(t->tm_wday + 1), to_bcd(t->tm_mday),
        to_bcd(t->tm_mon + 1), to_bcd(t->tm_year % 100),
    };
    for (size_t i = 0; i < len; i++) {
        size_t index = reg + i;
        buf[i] = (index < sizeof(regs)) ? regs[index] : 0;
    }
    return true;
}

// MPU6050 (0x68, registers 0x3B+): big-endian signed, 16384 LSB/g. A board
// sitting flat reads a small tilt on X and 1g on Z.
static bool mpu6050_read(uint8_t reg, uint8_t *buf, size_t len) {
    static const struct { uint8_t reg; int16_t value; } samples[] = {
        { 0x3B,   328 },  // accel x ≈ +0.02 g
        { 0x3D,  -164 },  // accel y ≈ -0.01 g
        { 0x3F, 16384 },  // accel z = 1.00 g
        { 0x43,     8 }, { 0x45, -12 }, { 0x47, 4 },   // gyro, near rest
    };
    int16_t value = 0;
    for (size_t i = 0; i < sizeof(samples) / sizeof(samples[0]); i++) {
        if (samples[i].reg == reg) { value = samples[i].value; break; }
    }
    if (len > 0) buf[0] = (uint8_t)(value >> 8);
    if (len > 1) buf[1] = (uint8_t)(value & 0xFF);
    for (size_t i = 2; i < len; i++) buf[i] = 0;
    return true;
}

// BMP280 (0x76/0x77): 20-bit raw samples that decode to ~21 C via the VM's
// simplified compensation.
static bool bmp280_read(uint8_t reg, uint8_t *buf, size_t len) {
    uint32_t adc = (reg == 0xFA) ? 671744u : 983040u;   // temp : pressure
    if (len > 0) buf[0] = (uint8_t)(adc >> 12);
    if (len > 1) buf[1] = (uint8_t)((adc >> 4) & 0xFF);
    if (len > 2) buf[2] = (uint8_t)((adc << 4) & 0xF0);
    for (size_t i = 3; i < len; i++) buf[i] = 0;
    return true;
}

bool hal_i2c_read_reg(uint8_t addr, uint8_t reg, uint8_t *buf, size_t len) {
    if (!quiet) printf("i2c read 0x%02X reg=0x%02X len=%u\n", addr, reg, (unsigned)len);

    if (vd_is_display_addr(addr)) {   // status byte: what the firmware's detection reads
        if (!vd_present(addr) || vd_kind == VD_SSD1306_NOREAD) return false;   // some clones never answer reads
        for (size_t i = 0; i < len; i++) buf[i] = vd_status();
        return true;
    }

    // 0x68 is shared by the DS3231 and the MPU6050; the register tells them apart.
    if (addr == 0x68 && reg <= 0x12) return ds3231_read(reg, buf, len);
    if (addr == 0x68)                return mpu6050_read(reg, buf, len);
    if (addr == 0x76 || addr == 0x77) return bmp280_read(reg, buf, len);

    for (size_t i = 0; i < len; i++) buf[i] = (uint8_t)(i + 1);   // unknown device
    return true;
}

void hal_i2c_scan(uint8_t *found, uint8_t *count) {
    found[0] = 0x68;
    *count = 1;
}

// SPI
void hal_spi_init(uint8_t mosi, uint8_t miso, uint8_t sck, uint8_t cs,
                  uint32_t freq_hz, uint8_t mode) {
    (void)miso; (void)sck;
    if (!quiet) printf("spi init mosi=%u cs=%u freq=%u mode=%u\n", mosi, cs, (unsigned)freq_hz, mode);
}
// Loopback, as if MISO were wired to MOSI: a chip answers with what it was sent.
bool hal_spi_exchange(uint8_t cs_pin, const uint8_t *tx, uint8_t *rx, uint8_t len) {
    if (!quiet) printf("spi exchange cs=%u len=%u\n", cs_pin, len);
    memmove(rx, tx, len);
    return true;
}
void hal_spi_cs_set(uint8_t cs_pin, bool active) {
    if (!quiet) printf("spi cs %u=%d\n", cs_pin, active ? 1 : 0);
}
void hal_spi_transfer(uint8_t cs_pin, const uint8_t *tx, uint8_t tx_len,
                      uint8_t *rx, uint8_t rx_len) {
    (void)tx; (void)tx_len;
    if (!quiet) printf("spi transfer cs=%u rx_len=%u\n", cs_pin, rx_len);
    // MAX31855-shaped sample: raw 100 in bits 31..18 → 100 * 0.25 = +25.00C.
    static const uint8_t sample[4] = { 0x01, 0x90, 0x01, 0x90 };
    for (uint8_t i = 0; i < rx_len; i++) rx[i] = (i < 4) ? sample[i] : 0;
}

// UART
// Replays a canned NMEA stream so the GPS parsers can be exercised.
static const char *nmea_stream[] = {
    "$GPRMC,081836,A,3751.65,S,14507.36,E,000.0,360.0,130998,011.3,E*62",
    "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47",
};
static int nmea_index = 0;

void hal_uart_init(uint8_t tx, uint8_t rx, uint32_t baud,
                   uint8_t bits, uint8_t parity, uint8_t stop) {
    (void)bits; (void)parity; (void)stop;
    if (!quiet) printf("uart init tx=%u rx=%u baud=%u\n", tx, rx, (unsigned)baud);
}

void hal_uart_write(const uint8_t *data, size_t len) {
    printf("uart write %.*s\n", (int)len, (const char *)data);
}

uint8_t hal_uart_read_bytes(uint8_t *buf, uint8_t max_len,
                            uint32_t timeout_ms, volatile bool *halt_flag) {
    (void)timeout_ms; (void)halt_flag;
    uint8_t n = max_len < 4 ? max_len : 4;
    for (uint8_t i = 0; i < n; i++) buf[i] = (uint8_t)(i + 1);
    return n;
}

bool hal_uart_read_line(char *buf, uint8_t max_len,
                        uint32_t timeout_ms, volatile bool *halt_flag) {
    (void)timeout_ms; (void)halt_flag;
    const char *line = nmea_stream[nmea_index % 2];
    nmea_index++;
    snprintf(buf, max_len, "%s", line);
    return true;
}

bool hal_uart_read_until(char *buf, uint8_t max_len, uint8_t terminator,
                         uint32_t timeout_ms, volatile bool *halt_flag) {
    (void)terminator;
    return hal_uart_read_line(buf, max_len, timeout_ms, halt_flag);
}

uint16_t hal_uart_available(void) { return 0; }
void     hal_uart_flush(void) {}

// Timing
void hal_sleep_us(uint32_t us) { sim_now_us += us; budget_check(); }
void hal_sleep_ms(uint32_t ms) { sim_now_us += (uint64_t)ms * 1000; budget_check(); }
uint64_t hal_time_us(void) { return sim_now_us; }

// NeoPixel
void hal_neopixel_init(uint8_t pin, uint16_t count) { printf("neo init %u count=%u\n", pin, count); }
void hal_neopixel_set(uint8_t pin, uint16_t index, uint8_t r, uint8_t g, uint8_t b) {
    printf("neo %u [%u]=%u,%u,%u\n", pin, index, r, g, b);
}
void hal_neopixel_set_all(uint8_t pin, uint8_t r, uint8_t g, uint8_t b) {
    printf("neo %u all=%u,%u,%u\n", pin, r, g, b);
}
void hal_neopixel_brightness(uint8_t pin, uint8_t brightness) {
    printf("neo %u brightness=%u\n", pin, brightness);
}
void hal_neopixel_show(uint8_t pin) { printf("neo %u show\n", pin); }

// HID
void hal_hid_key(uint8_t modifier, uint8_t keycode) {
    printf("hid key mod=0x%02X code=0x%02X\n", modifier, keycode);
}
void hal_hid_type(const char *text, uint8_t len) {
    printf("hid type %.*s\n", (int)len, text);
}
void hal_hid_mouse(int8_t dx, int8_t dy, uint8_t buttons, int8_t scroll) {
    printf("hid mouse dx=%d dy=%d buttons=%u scroll=%d\n", dx, dy, buttons, scroll);
}
void hal_hid_pump(void) {}

// Radio
// A virtual access point: joining succeeds, HTTP returns a canned body. Enough
// to test program logic; --no-radio makes the board look radio-less instead.
static bool radio_present = true;
static bool wifi_joined = false;

bool hal_radio_available(void) { return radio_present; }
bool hal_radio_led(bool on) {
    if (radio_present) printf("gpio %d=%d\n", ZAPP_PIN_RADIO_LED, on);
    return radio_present;
}

bool hal_wifi_connect(const char *ssid, const char *password, uint32_t timeout_ms) {
    (void)password; (void)timeout_ms;
    printf("wifi connect ssid=%s\n", ssid);
    wifi_joined = ssid[0] != '\0';
    return wifi_joined;
}

static bool wifi_ap = false;

bool hal_wifi_start_ap(const char *ssid, const char *password) {
    printf("wifi ap ssid=%s%s\n", ssid, password[0] ? "" : " open");
    wifi_ap = true;
    return true;
}

bool hal_web_serve(void) {
    printf("web serve port=80\n");
    return true;
}

bool hal_wifi_connected(void) { return wifi_joined; }

void hal_wifi_ip(char *out, size_t out_len) {
    snprintf(out, out_len, "%s", wifi_ap ? "192.168.4.1" : wifi_joined ? "192.168.1.42" : "0.0.0.0");
}

int hal_http_request(const char *method, const char *url,
                     const char *body, char *out, size_t out_len) {
    printf("http %s %s%s%s\n", method, url, body ? " body=" : "", body ? body : "");
    if (!wifi_joined) return 0;
    snprintf(out, out_len, "{\"ok\":true}");
    return 200;
}

// A virtual BLE central: connects as soon as the board advertises, and has one
// message waiting so `ble message` can be tested.
static bool ble_advertising = false;
static bool ble_message_pending = true;

bool hal_ble_available(void) { return radio_present; }

bool hal_ble_advertise(const char *name) {
    printf("ble advertise name=%s\n", name);
    ble_advertising = true;
    return true;
}

bool hal_ble_connected(void) { return ble_advertising; }

bool hal_ble_notify(const char *text) {
    if (!ble_advertising) return false;
    printf("ble notify %s\n", text);
    return true;
}

bool hal_ble_message(char *out, size_t out_len) {
    if (!ble_advertising || !ble_message_pending) {
        if (out_len) out[0] = '\0';
        return false;
    }
    ble_message_pending = false;   // each message is delivered once
    snprintf(out, out_len, "hello board");
    return true;
}

void hal_radio_poll(void) {}

// Debug output
void hal_debug_print(const char *s) { fputs(s, stdout); }

void hal_debug_println(const char *s) {
    printf("%s\n", s);
    print_count++;
    budget_check();
}

// Harness
static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int main(int argc, char **argv) {
    static char input[16384];
    const char *payload = NULL;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--quiet") == 0) {
            quiet = true;
        } else if (strcmp(argv[i], "--no-display") == 0) {
            show_display = false;
        } else if (strcmp(argv[i], "--fb") == 0) {
            dump_fb = true;
            show_display = false;   // the hex dump replaces the ASCII art
        } else if (strcmp(argv[i], "--display") == 0 && i + 1 < argc) {
            const char *kind = argv[++i];
            vd_addr = (strstr(kind, "@3d") || strstr(kind, "@3D")) ? 0x3D : 0x3C;
            if (strncmp(kind, "ssd1306_32", 10) == 0)  vd_kind = VD_SSD1306_32;
            else if (strncmp(kind, "ssd1306_noread", 14) == 0) vd_kind = VD_SSD1306_NOREAD;
            else if (strncmp(kind, "ssd1306", 7) == 0) vd_kind = VD_SSD1306;
            else if (strncmp(kind, "sh1106", 6) == 0)  vd_kind = VD_SH1106;
            else if (strncmp(kind, "none", 4) == 0)    vd_kind = VD_NONE;
            else { fprintf(stderr, "unknown --display %s\n", kind); return 2; }
        } else if (strcmp(argv[i], "--no-radio") == 0) {
            radio_present = false;   // pretend to be a plain RP2040
        } else if (strcmp(argv[i], "--gpio") == 0 && i + 1 < argc) {
            int pin = 0, value = 0;
            if (sscanf(argv[++i], "%d=%d", &pin, &value) == 2 && pin >= 0 && pin < 64) {
                gpio_state[pin] = value != 0;
            }
        } else {
            payload = argv[i];
        }
    }

    if (payload) {
        snprintf(input, sizeof(input), "%s", payload);
    } else if (!fgets(input, sizeof(input), stdin)) {
        fprintf(stderr, "usage: vm_host BC:<hex>\n");
        return 2;
    }

    char *hex = strstr(input, "BC:");
    if (hex) {
        hex += 3;
    } else if ((hex = strstr(input, "RUN:")) != NULL) {
        hex += 4;
    } else {
        fprintf(stderr, "input is not a BC: or RUN: payload\n");
        return 2;
    }

    static uint8_t bc[4096];
    uint16_t len = 0;
    for (size_t i = 0; hex[i] && hex[i + 1] && len < sizeof(bc); i += 2) {
        int hi = hex_nibble(hex[i]), lo = hex_nibble(hex[i + 1]);
        if (hi < 0 || lo < 0) break;
        bc[len++] = (uint8_t)((hi << 4) | lo);
    }

    vm_init();
    vm_run(bc, len);
    vd_render();
    vd_dump();
    fprintf(stderr, "-- %u bytes of bytecode, %llu ms simulated\n",
            len, (unsigned long long)(sim_now_us / 1000));
    return 0;
}
