#include "vm.h"
#include "hal.h"
#include "hal_radio.h"
#include "config.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static VM vm_ctx;
static volatile bool vm_halt_signal = false;
static char vm_fail_msg[96];   // why the last run failed ("" = it didn't), for the idle screen

// Stop the program with a message — a silent halt just looks like a hang.
static void vm_fail(const char *msg) {
    if (!vm_ctx.halted) {
        hal_debug_println(msg);
        snprintf(vm_fail_msg, sizeof(vm_fail_msg), "%s", msg);
    }
    vm_ctx.halted = true;
}

static bool vm_require_bytes(uint16_t count) {
    if ((uint32_t)vm_ctx.ip + count > vm_ctx.bc_len) {
        vm_fail("VM Error: bytecode is truncated");
        return false;
    }
    return true;
}

// BMP280: every chip has factory calibration at 0x88-0x9F (24 bytes, little
// endian). Read once per address and kept; the maths is the datasheet's
// integer version (BMP280 datasheet §8.2).
static uint8_t vm_last_i2c_addr;

typedef struct {
    uint8_t addr;
    bool ok;
    uint16_t T1; int16_t T2, T3;
    uint16_t P1; int16_t P2, P3, P4, P5, P6, P7, P8, P9;
    int32_t t_fine;
} Bmp280Calib;

static Bmp280Calib bmp280_cal;

static const Bmp280Calib *bmp280_calib(uint8_t addr) {
    if (bmp280_cal.ok && bmp280_cal.addr == addr) return &bmp280_cal;
    uint8_t c[24];
    if (!hal_i2c_read_reg(addr, 0x88, c, sizeof(c))) {
        vm_fail("Hardware Error: couldn't read the BMP280's calibration");
        return NULL;
    }
#define U16(i) (uint16_t)(c[i] | (c[(i) + 1] << 8))
#define S16(i) (int16_t)U16(i)
    bmp280_cal = (Bmp280Calib){ .addr = addr, .ok = true,
        .T1 = U16(0), .T2 = S16(2), .T3 = S16(4),
        .P1 = U16(6), .P2 = S16(8), .P3 = S16(10), .P4 = S16(12), .P5 = S16(14),
        .P6 = S16(16), .P7 = S16(18), .P8 = S16(20), .P9 = S16(22) };
#undef U16
#undef S16
    return &bmp280_cal;
}

// Hundredths of a degree C. Also sets t_fine, which pressure needs.
static int32_t bmp280_temp_centi(const Bmp280Calib *c, int32_t adc_t) {
    int32_t var1 = ((((adc_t >> 3) - ((int32_t)c->T1 << 1))) * (int32_t)c->T2) >> 11;
    int32_t d = (adc_t >> 4) - (int32_t)c->T1;
    int32_t var2 = (((d * d) >> 12) * (int32_t)c->T3) >> 14;
    bmp280_cal.t_fine = var1 + var2;
    return (bmp280_cal.t_fine * 5 + 128) >> 8;
}

// Pascals as Q24.8 (divide by 256 for Pa).
static uint32_t bmp280_pressure_q24_8(const Bmp280Calib *c, int32_t adc_p) {
    int64_t var1 = (int64_t)bmp280_cal.t_fine - 128000;
    int64_t var2 = var1 * var1 * (int64_t)c->P6;
    var2 += (var1 * (int64_t)c->P5) << 17;
    var2 += (int64_t)c->P4 << 35;
    var1 = ((var1 * var1 * (int64_t)c->P3) >> 8) + ((var1 * (int64_t)c->P2) << 12);
    var1 = ((((int64_t)1 << 47) + var1) * (int64_t)c->P1) >> 33;
    if (var1 == 0) return 0;   // no calibration: avoid dividing by zero
    int64_t p = 1048576 - adc_p;
    p = (((p << 31) - var2) * 3125) / var1;
    var1 = ((int64_t)c->P9 * (p >> 13) * (p >> 13)) >> 25;
    var2 = ((int64_t)c->P8 * p) >> 19;
    p = ((p + var1 + var2) >> 8) + ((int64_t)c->P7 << 4);
    return (uint32_t)p;
}

static uint8_t bcd_to_dec(uint8_t bcd) {
    return (uint8_t)(((bcd >> 4) * 10) + (bcd & 0x0F));
}

// Read a big-endian u32 operand at ip and advance past it.
static uint32_t vm_read_u32(void) {
    uint32_t v = ((uint32_t)vm_ctx.bc[vm_ctx.ip] << 24) |
                 ((uint32_t)vm_ctx.bc[vm_ctx.ip+1] << 16) |
                 ((uint32_t)vm_ctx.bc[vm_ctx.ip+2] << 8) |
                 ((uint32_t)vm_ctx.bc[vm_ctx.ip+3]);
    vm_ctx.ip += 4;
    return v;
}

static ZappVal vm_num(float v) {
    ZappVal val = { .type = VAL_NUM, .num = v };
    return val;
}

static ZappVal vm_int(int32_t i) {
    ZappVal val = { .type = VAL_INT, .i = i };
    return val;
}

// A whole-valued result (round, floor, //) as a whole number when it fits.
static ZappVal vm_whole_or_num(double d) {
    if (d == floor(d) && d >= -2147483648.0 && d <= 2147483647.0) return vm_int((int32_t)d);
    return vm_num((float)d);
}

// Whole numbers (and true/false) take the exact integer paths.
static bool vm_is_whole(ZappVal v) {
    return v.type == VAL_INT || v.type == VAL_BOOL;
}

// Pin operands are literal bytes, except 0xFF which means "the pin is on the
// stack" — that's how a pin can come from a variable or function parameter.
#define PIN_FROM_STACK 0xFF

static ZappVal vm_bool(bool v) {
    ZappVal val = { .type = VAL_BOOL, .boolean = v };
    return val;
}

static float vm_to_num(ZappVal v);

// Resolve a pin operand, popping the stack for the PIN_FROM_STACK sentinel.
static uint8_t vm_pin(uint8_t operand);

static float vm_to_num(ZappVal v) {
    if (v.type == VAL_NUM)  return v.num;
    if (v.type == VAL_INT)  return (float)v.i;
    if (v.type == VAL_BOOL) return v.boolean ? 1.0f : 0.0f;
    return 0.0f;
}

static uint8_t vm_pin_or_led(uint8_t operand, bool allow_radio_led) {
    float v = (operand == PIN_FROM_STACK) ? vm_to_num(vm_pop(&vm_ctx)) : operand;
    if (allow_radio_led && v == ZAPP_PIN_RADIO_LED) return ZAPP_PIN_RADIO_LED;
    // Range-check as a float: casting an out-of-range float to uint8_t is UB.
    if (!(v >= 0.0f && v < ZAPP_GPIO_COUNT)) {
        vm_fail("Hardware Error: pin number out of range");
        return 0;
    }
    return (uint8_t)v;
}

static uint8_t vm_pin(uint8_t operand) {
    return vm_pin_or_led(operand, false);
}

static ZappVal vm_nil(void) {
    ZappVal val = { .type = VAL_NIL };
    return val;
}

// Read a length-prefixed string operand into a caller buffer.
static bool vm_read_inline_str(char *out, size_t out_len) {
    if (!vm_require_bytes(1)) return false;
    uint8_t len = vm_ctx.bc[vm_ctx.ip++];
    if (!vm_require_bytes(len)) return false;
    size_t copy = (len < out_len - 1) ? len : out_len - 1;
    memcpy(out, &vm_ctx.bc[vm_ctx.ip], copy);
    out[copy] = '\0';
    vm_ctx.ip += len;
    return true;
}

// Radio opcodes are only reachable on boards that have one.
static bool vm_radio_ready(void) {
    if (hal_radio_available()) return true;
    vm_fail("Hardware Error: this board has no radio");
    return false;
}

// BLE opcodes are only reachable on boards with a Bluetooth radio.
static bool vm_ble_ready(void) {
    if (hal_ble_available()) return true;
    vm_fail("Hardware Error: this board has no bluetooth");
    return false;
}

static bool vm_truthy(ZappVal v) {
    switch (v.type) {
        case VAL_NUM:   return v.num != 0.0f;
        case VAL_INT:   return v.i != 0;
        case VAL_BOOL:  return v.boolean;
        case VAL_STR:   return v.str.len > 0;
        case VAL_BYTES: return v.bytes.len > 0;
        default:        return false;
    }
}

// Render any value as text — used by print, display and string concatenation.
static void vm_format(ZappVal v, char *buf, size_t n) {
    switch (v.type) {
        case VAL_NUM:
            // Whole numbers print in full (16777216, not 1.67772e+07).
            if (v.num == floorf(v.num) && fabsf(v.num) < 1e15f)
                snprintf(buf, n, "%.0f", (double)v.num);
            else
                snprintf(buf, n, "%g", (double)v.num);
            break;
        case VAL_INT:  snprintf(buf, n, "%ld", (long)v.i); break;
        case VAL_BOOL: snprintf(buf, n, "%s", v.boolean ? "true" : "false"); break;
        case VAL_STR:  snprintf(buf, n, "%.*s", v.str.len, v.str.buf); break;
        case VAL_BYTES: {
            size_t pos = 0;
            for (uint8_t i = 0; i < v.bytes.len && pos + 3 < n; i++) {
                pos += (size_t)snprintf(buf + pos, n - pos, "%02X", v.bytes.buf[i]);
            }
            if (v.bytes.len == 0 && n) buf[0] = '\0';
            break;
        }
        default: snprintf(buf, n, "nil"); break;
    }
}

// Relative jump with bounds check; halts on an out-of-range target.
static void vm_jump(int16_t offset) {
    int32_t target = (int32_t)vm_ctx.ip + offset;
    if (target < 0 || target > vm_ctx.bc_len) {
        vm_fail("VM Error: jump out of range");
        return;
    }
    vm_ctx.ip = (uint16_t)target;
}

static int16_t vm_read_i16(void) {
    int16_t v = (int16_t)((vm_ctx.bc[vm_ctx.ip] << 8) | vm_ctx.bc[vm_ctx.ip+1]);
    vm_ctx.ip += 2;
    return v;
}

// Numbers
// `num` holds a whole number (int32, exact) or a decimal (float32). Whole op
// whole stays whole unless it overflows, then it becomes a decimal rather than
// wrapping round to a negative. `/` always gives the real answer (7 / 2 = 3.5);
// `//` and `%` are floored, like Python.

static int32_t vm_whole_value(ZappVal v) {
    return v.type == VAL_INT ? v.i : (v.boolean ? 1 : 0);
}

// A value as a whole number for bit operations, bus addresses and indexes.
// Decimals are truncated; anything else stops the program.
static int32_t vm_to_whole(ZappVal v) {
    if (vm_is_whole(v)) return vm_whole_value(v);
    if (v.type == VAL_NUM) {
        if (v.num >= -2147483648.0f && v.num < 2147483648.0f) return (int32_t)v.num;
        vm_fail("VM Error: number too big for a whole number");
        return 0;
    }
    vm_fail("VM Error: expected a number");
    return 0;
}

static ZappVal vm_arith(ZappOpcode op, ZappVal a, ZappVal b) {
    if (vm_is_whole(a) && vm_is_whole(b)) {
        int32_t x = vm_whole_value(a), y = vm_whole_value(b), r;
        switch (op) {
            case OP_ADD: if (!__builtin_add_overflow(x, y, &r)) return vm_int(r);
                         return vm_num((float)((double)x + y));
            case OP_SUB: if (!__builtin_sub_overflow(x, y, &r)) return vm_int(r);
                         return vm_num((float)((double)x - y));
            case OP_MUL: if (!__builtin_mul_overflow(x, y, &r)) return vm_int(r);
                         return vm_num((float)((double)x * y));
            case OP_POW: {
                if (y < 0) return vm_num((float)pow(x, y));
                int64_t acc = 1;
                for (int32_t i = 0; i < y; i++) {
                    acc *= x;
                    if (acc > INT32_MAX || acc < INT32_MIN) return vm_num((float)pow(x, y));
                }
                return vm_int((int32_t)acc);
            }
            default: break;
        }
        if (y == 0) { vm_fail("VM Error: divide by zero"); return vm_int(0); }
        if (x == INT32_MIN && y == -1) return vm_num(2147483648.0f);
        switch (op) {
            case OP_DIV:
                if (x % y == 0) return vm_int(x / y);
                return vm_num((float)((double)x / y));
            case OP_IDIV:
                r = x / y;
                if (x % y != 0 && ((x < 0) != (y < 0))) r--;
                return vm_int(r);
            default:   // OP_MOD
                r = x % y;
                if (r != 0 && ((r < 0) != (y < 0))) r += y;
                return vm_int(r);
        }
    }

    float x = vm_to_num(a), y = vm_to_num(b);
    switch (op) {
        case OP_ADD: return vm_num(x + y);
        case OP_SUB: return vm_num(x - y);
        case OP_MUL: return vm_num(x * y);
        case OP_POW: return vm_num(powf(x, y));
        default: break;
    }
    if (y == 0.0f) { vm_fail("VM Error: divide by zero"); return vm_int(0); }
    switch (op) {
        case OP_DIV:  return vm_num(x / y);
        case OP_IDIV: return vm_whole_or_num(floor((double)x / y));
        default: {    // OP_MOD
            float r = fmodf(x, y);
            if (r != 0.0f && ((r < 0) != (y < 0))) r += y;
            return vm_num(r);
        }
    }
}

// -1 for a < b, 0 equal, 1 greater. Whole numbers compare exactly.
static int vm_compare(ZappVal a, ZappVal b) {
    if (vm_is_whole(a) && vm_is_whole(b)) {
        int32_t x = vm_whole_value(a), y = vm_whole_value(b);
        return (x > y) - (x < y);
    }
    float x = vm_to_num(a), y = vm_to_num(b);
    return (x > y) - (x < y);
}

static ZappVal vm_bitop(ZappOpcode op, ZappVal a, ZappVal b) {
    int32_t x = vm_to_whole(a), y = vm_to_whole(b);
    switch (op) {
        case OP_BAND: return vm_int(x & y);
        case OP_BOR:  return vm_int(x | y);
        case OP_BXOR: return vm_int(x ^ y);
        default:
            if (y < 0 || y > 31) { vm_fail("VM Error: shift by 0-31 bits"); return vm_int(0); }
            if (op == OP_SHL) return vm_int((int32_t)((uint32_t)x << y));
            return vm_int(x >> y);   // OP_SHR, keeps the sign
    }
}

// Ids match MATH_FUNCTIONS in the compiler's emitter.ts.
typedef enum {
    MATH_ABS = 0, MATH_ROUND, MATH_FLOOR, MATH_CEIL, MATH_SQRT,
    MATH_SIN, MATH_COS, MATH_TAN,       // degrees
    MATH_MIN, MATH_MAX, MATH_CLAMP, MATH_MAP,
    MATH_RANDOM,                        // random(lo, hi): a whole number, both ends included
} MathFn;

static uint32_t vm_rng_state = 0x9E3779B9u;

static uint32_t vm_rng(void) {   // xorshift32
    uint32_t x = vm_rng_state;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return vm_rng_state = x;
}

#define VM_DEG_TO_RAD 0.017453292519943295

// Pops the function's arguments (pushed in order) and pushes its result.
static void vm_math(MathFn fn) {
    static const uint8_t argc[] = { 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 3, 5, 2 };
    if ((unsigned)fn >= sizeof(argc)) { vm_fail("VM Error: unknown math function"); return; }
    ZappVal arg[5];
    for (int i = argc[fn] - 1; i >= 0; i--) arg[i] = vm_pop(&vm_ctx);
    if (vm_ctx.halted) return;
    double x = vm_to_num(arg[0]);
    ZappVal out;
    switch (fn) {
        case MATH_ABS:
            if (vm_is_whole(arg[0]) && vm_whole_value(arg[0]) != INT32_MIN) {
                int32_t i = vm_whole_value(arg[0]);
                out = vm_int(i < 0 ? -i : i);
            } else {
                out = vm_num(fabsf((float)x));
            }
            break;
        case MATH_ROUND: out = vm_is_whole(arg[0]) ? arg[0] : vm_whole_or_num(round(x)); break;
        case MATH_FLOOR: out = vm_is_whole(arg[0]) ? arg[0] : vm_whole_or_num(floor(x)); break;
        case MATH_CEIL:  out = vm_is_whole(arg[0]) ? arg[0] : vm_whole_or_num(ceil(x)); break;
        case MATH_SQRT:
            if (x < 0) { vm_fail("VM Error: square root of a negative number"); return; }
            out = vm_num((float)sqrt(x));
            break;
        case MATH_SIN: out = vm_num((float)sin(x * VM_DEG_TO_RAD)); break;
        case MATH_COS: out = vm_num((float)cos(x * VM_DEG_TO_RAD)); break;
        case MATH_TAN: out = vm_num((float)tan(x * VM_DEG_TO_RAD)); break;
        case MATH_MIN: out = vm_compare(arg[0], arg[1]) <= 0 ? arg[0] : arg[1]; break;
        case MATH_MAX: out = vm_compare(arg[0], arg[1]) >= 0 ? arg[0] : arg[1]; break;
        case MATH_CLAMP:
            out = vm_compare(arg[0], arg[1]) < 0 ? arg[1]
                : vm_compare(arg[0], arg[2]) > 0 ? arg[2] : arg[0];
            break;
        case MATH_MAP: {
            // map(x, from_lo, from_hi, to_lo, to_hi): rescale, like Arduino's map.
            double in_lo = vm_to_num(arg[1]), in_hi = vm_to_num(arg[2]);
            double out_lo = vm_to_num(arg[3]), out_hi = vm_to_num(arg[4]);
            if (in_lo == in_hi) { vm_fail("VM Error: map needs two different 'from' values"); return; }
            out = vm_num((float)(out_lo + (x - in_lo) * (out_hi - out_lo) / (in_hi - in_lo)));
            break;
        }
        default: {   // MATH_RANDOM
            int32_t lo = vm_to_whole(arg[0]), hi = vm_to_whole(arg[1]);
            if (hi < lo) { int32_t t = lo; lo = hi; hi = t; }
            uint32_t span = (uint32_t)((int64_t)hi - lo + 1);
            out = vm_int((int32_t)((int64_t)lo + (span ? vm_rng() % span : vm_rng())));
            break;
        }
    }
    vm_push(&vm_ctx, out);
}

// Bytes

// Data to put on a bus: bytes as they are, text as its characters, a number
// as one byte. Returns the length, or -1 (and stops the program) otherwise.
static int vm_data_bytes(ZappVal v, uint8_t *out, size_t max) {
    if (v.type == VAL_BYTES) { memcpy(out, v.bytes.buf, v.bytes.len); return v.bytes.len; }
    if (v.type == VAL_STR) {
        size_t n = v.str.len < max ? v.str.len : max;
        memcpy(out, v.str.buf, n);
        return (int)n;
    }
    if (v.type == VAL_INT || v.type == VAL_NUM || v.type == VAL_BOOL) {
        int32_t b = vm_to_whole(v);
        if (b < 0 || b > 255) { vm_fail("VM Error: a byte is 0-255"); return -1; }
        out[0] = (uint8_t)b;
        return 1;
    }
    vm_fail("VM Error: expected bytes, text or a number to send");
    return -1;
}

// An index into something `len` long; negative counts from the end.
static int vm_index(ZappVal idx, int len) {
    int32_t i = vm_to_whole(idx);
    if (vm_ctx.halted) return -1;
    if (i < 0) i += len;
    if (i < 0 || i >= len) {
        char msg[64];
        snprintf(msg, sizeof(msg), "VM Error: index %ld is past the end (length %d)", (long)vm_to_whole(idx), len);
        vm_fail(msg);
        return -1;
    }
    return i;
}

// Transform Identifiers for OP_TRANSFORM mapped via ZappMods
typedef enum {
    TRANSFORM_RAW_U8 = 0,
    TRANSFORM_RAW_U16_BE,
    TRANSFORM_RAW_U16_LE,
    TRANSFORM_RAW_I16_BE,
    TRANSFORM_RAW_I16_LE,
    TRANSFORM_SCALED_100,
    TRANSFORM_SCALED_1000,
    TRANSFORM_TWOS_COMPLEMENT_16,
    TRANSFORM_BCD_BYTE,
    TRANSFORM_BMP280_TEMP,
    TRANSFORM_BMP280_PRESSURE,
    TRANSFORM_DS3231_TIME,
    TRANSFORM_DS3231_DATE,
    TRANSFORM_MPU6050_ACCEL,
    TRANSFORM_MPU6050_GYRO,
} TransformId;

// NMEA 0183 sentence parsing (OP_UART_APPLY_PARSER)
// Parser ids match PARSER_IDS in the compiler's emitter.ts.
#define PARSER_NMEA_GGA_LAT    0x01
#define PARSER_NMEA_GGA_LON    0x02
#define PARSER_NMEA_GGA_ALT    0x03
#define PARSER_NMEA_GGA_FIX    0x04
#define PARSER_NMEA_RMC_SPEED  0x05

// "$GPGGA,..." or "$GNGGA,..." — talker id (chars 1-2) varies by constellation.
static bool nmea_is(const char *line, const char *type) {
    return line[0] == '$' && strlen(line) > 6 && strncmp(line + 3, type, 3) == 0;
}

// Copy comma-separated field `idx` (0 = the "$GPGGA" tag) into out.
static bool nmea_field(const char *line, int idx, char *out, size_t n) {
    int field = 0;
    size_t pos = 0;
    for (const char *c = line; ; c++) {
        if (*c == ',' || *c == '*' || *c == '\0') {
            if (field == idx) {
                out[pos] = '\0';
                return pos > 0;
            }
            field++;
            pos = 0;
            if (*c == '\0' || *c == '*') break;
            continue;
        }
        if (field == idx && pos + 1 < n) out[pos++] = *c;
    }
    out[0] = '\0';
    return false;
}

// NMEA position is ddmm.mmmm / dddmm.mmmm — convert to signed decimal degrees.
static float nmea_degrees(const char *ddmm, const char *hemi) {
    float raw = strtof(ddmm, NULL);
    float deg = (float)((int)raw / 100);
    float min = raw - deg * 100.0f;
    float out = deg + min / 60.0f;
    if (hemi[0] == 'S' || hemi[0] == 'W') out = -out;
    return out;
}

// Display driver (SSD1306 etc.)

// Controller ids match DISPLAY_CONTROLLERS in the compiler's emitter.ts.
#define DISPLAY_CONTROLLER_AUTO     0x00
#define DISPLAY_CONTROLLER_SSD1306  0x01
#define DISPLAY_CONTROLLER_SH1106   0x02
#define DISPLAY_MAX_WIDTH           128
#define DISPLAY_MAX_PAGES           8
#define DISPLAY_FB_SIZE             (DISPLAY_MAX_WIDTH * DISPLAY_MAX_PAGES)
#define DISPLAY_DRAW_AT_CURSOR      0x01   // OP_DISPLAY_DRAW flag: ignore x/y

static struct {
    uint8_t  addr;
    uint8_t  width;
    uint8_t  height;
    uint8_t  pages;
    uint8_t  controller;
    uint8_t  cursor_y;                       // next line for `display` without `at`
    bool     initialized;
    uint8_t  framebuffer[DISPLAY_FB_SIZE];   // 1024 bytes for 128×64, page-major
} display;

// 5×7 ASCII font, chars 32–126 (95 glyphs × 5 bytes = 475 bytes)
// Each byte is one column; bit 0 = top row, bit 6 = bottom row.
static const uint8_t font5x7[475] = {
    0x00,0x00,0x00,0x00,0x00, // 32 (space)
    0x00,0x00,0x5F,0x00,0x00, // 33 !
    0x00,0x07,0x00,0x07,0x00, // 34 "
    0x14,0x7F,0x14,0x7F,0x14, // 35 #
    0x24,0x2A,0x7F,0x2A,0x12, // 36 $
    0x23,0x13,0x08,0x64,0x62, // 37 %
    0x36,0x49,0x55,0x22,0x50, // 38 &
    0x00,0x05,0x03,0x00,0x00, // 39 '
    0x00,0x1C,0x22,0x41,0x00, // 40 (
    0x00,0x41,0x22,0x1C,0x00, // 41 )
    0x14,0x08,0x3E,0x08,0x14, // 42 *
    0x08,0x08,0x3E,0x08,0x08, // 43 +
    0x00,0x50,0x30,0x00,0x00, // 44 ,
    0x08,0x08,0x08,0x08,0x08, // 45 -
    0x00,0x60,0x60,0x00,0x00, // 46 .
    0x20,0x10,0x08,0x04,0x02, // 47 /
    0x3E,0x51,0x49,0x45,0x3E, // 48 0
    0x00,0x42,0x7F,0x40,0x00, // 49 1
    0x42,0x61,0x51,0x49,0x46, // 50 2
    0x21,0x41,0x45,0x4B,0x31, // 51 3
    0x18,0x14,0x12,0x7F,0x10, // 52 4
    0x27,0x45,0x45,0x45,0x39, // 53 5
    0x3C,0x4A,0x49,0x49,0x30, // 54 6
    0x01,0x71,0x09,0x05,0x03, // 55 7
    0x36,0x49,0x49,0x49,0x36, // 56 8
    0x06,0x49,0x49,0x29,0x1E, // 57 9
    0x00,0x36,0x36,0x00,0x00, // 58 :
    0x00,0x56,0x36,0x00,0x00, // 59 ;
    0x08,0x14,0x22,0x41,0x00, // 60 <
    0x14,0x14,0x14,0x14,0x14, // 61 =
    0x00,0x41,0x22,0x14,0x08, // 62 >
    0x02,0x01,0x51,0x09,0x06, // 63 ?
    0x32,0x49,0x79,0x41,0x3E, // 64 @
    0x7E,0x11,0x11,0x11,0x7E, // 65 A
    0x7F,0x49,0x49,0x49,0x36, // 66 B
    0x3E,0x41,0x41,0x41,0x22, // 67 C
    0x7F,0x41,0x41,0x22,0x1C, // 68 D
    0x7F,0x49,0x49,0x49,0x41, // 69 E
    0x7F,0x09,0x09,0x09,0x01, // 70 F
    0x3E,0x41,0x49,0x49,0x7A, // 71 G
    0x7F,0x08,0x08,0x08,0x7F, // 72 H
    0x00,0x41,0x7F,0x41,0x00, // 73 I
    0x20,0x40,0x41,0x3F,0x01, // 74 J
    0x7F,0x08,0x14,0x22,0x41, // 75 K
    0x7F,0x40,0x40,0x40,0x40, // 76 L
    0x7F,0x02,0x0C,0x02,0x7F, // 77 M
    0x7F,0x04,0x08,0x10,0x7F, // 78 N
    0x3E,0x41,0x41,0x41,0x3E, // 79 O
    0x7F,0x09,0x09,0x09,0x06, // 80 P
    0x3E,0x41,0x51,0x21,0x5E, // 81 Q
    0x7F,0x09,0x19,0x29,0x46, // 82 R
    0x46,0x49,0x49,0x49,0x31, // 83 S
    0x01,0x01,0x7F,0x01,0x01, // 84 T
    0x3F,0x40,0x40,0x40,0x3F, // 85 U
    0x1F,0x20,0x40,0x20,0x1F, // 86 V
    0x3F,0x40,0x38,0x40,0x3F, // 87 W
    0x63,0x14,0x08,0x14,0x63, // 88 X
    0x07,0x08,0x70,0x08,0x07, // 89 Y
    0x61,0x51,0x49,0x45,0x43, // 90 Z
    0x00,0x7F,0x41,0x41,0x00, // 91 [
    0x02,0x04,0x08,0x10,0x20, // 92 backslash
    0x00,0x41,0x41,0x7F,0x00, // 93 ]
    0x04,0x02,0x01,0x02,0x04, // 94 ^
    0x40,0x40,0x40,0x40,0x40, // 95 _
    0x00,0x01,0x02,0x04,0x00, // 96 `
    0x20,0x54,0x54,0x54,0x78, // 97 a
    0x7F,0x48,0x44,0x44,0x38, // 98 b
    0x38,0x44,0x44,0x44,0x20, // 99 c
    0x38,0x44,0x44,0x48,0x7F, // 100 d
    0x38,0x54,0x54,0x54,0x18, // 101 e
    0x08,0x7E,0x09,0x01,0x02, // 102 f
    0x0C,0x52,0x52,0x52,0x3E, // 103 g
    0x7F,0x08,0x04,0x04,0x78, // 104 h
    0x00,0x44,0x7D,0x40,0x00, // 105 i
    0x20,0x40,0x44,0x3D,0x00, // 106 j
    0x7F,0x10,0x28,0x44,0x00, // 107 k
    0x00,0x41,0x7F,0x40,0x00, // 108 l
    0x7C,0x04,0x18,0x04,0x78, // 109 m
    0x7C,0x08,0x04,0x04,0x78, // 110 n
    0x38,0x44,0x44,0x44,0x38, // 111 o
    0x7C,0x14,0x14,0x14,0x08, // 112 p
    0x08,0x14,0x14,0x18,0x7C, // 113 q
    0x7C,0x08,0x04,0x04,0x08, // 114 r
    0x48,0x54,0x54,0x54,0x20, // 115 s
    0x04,0x3F,0x44,0x40,0x20, // 116 t
    0x3C,0x40,0x40,0x20,0x7C, // 117 u
    0x1C,0x20,0x40,0x20,0x1C, // 118 v
    0x3C,0x40,0x30,0x40,0x3C, // 119 w
    0x44,0x28,0x10,0x28,0x44, // 120 x
    0x0C,0x50,0x50,0x50,0x3C, // 121 y
    0x44,0x64,0x54,0x4C,0x44, // 122 z
    0x00,0x08,0x36,0x41,0x00, // 123 {
    0x00,0x00,0x7F,0x00,0x00, // 124 |
    0x00,0x41,0x36,0x08,0x00, // 125 }
    0x10,0x08,0x08,0x10,0x10, // 126 ~
};

// Render one character at pixel column x, page row p into the framebuffer.
static void display_pixel(int x, int y, bool on) {
    if (x < 0 || y < 0 || x >= display.width || y >= display.height) return;
    uint8_t *b = &display.framebuffer[(y / 8) * display.width + x];
    if (on) *b |= (uint8_t)(1u << (y & 7));
    else    *b &= (uint8_t)~(1u << (y & 7));
}

// Draw text with its top-left at (x, y) pixels, each font pixel scaled to a
// size×size block. The text replaces everything from x to the right edge in
// its rows, so updating "100" to "99" doesn't leave a stray "0" behind.
static void display_draw_string(int x, int y, uint8_t size, const char *text) {
    if (size < 1) size = 1;
    int h = 8 * size;   // 7-pixel glyph + 1 row gap
    for (int row = y; row < y + h; row++)
        for (int col = x; col < display.width; col++) display_pixel(col, row, false);

    for (; *text && x < display.width; text++, x += 6 * size) {
        char c = (*text < 32 || *text > 126) ? '?' : *text;
        const uint8_t *glyph = &font5x7[(c - 32) * 5];
        for (int col = 0; col < 5; col++)
            for (int bit = 0; bit < 7; bit++)
                if (glyph[col] & (1u << bit))
                    for (int dy = 0; dy < size; dy++)
                        for (int dx = 0; dx < size; dx++)
                            display_pixel(x + col * size + dx, y + bit * size + dy, true);
    }
}

// Send pages first..last of the framebuffer. The SSD1306 takes a page window
// (0x21/0x22); the SH1106 only has page mode, and its 132-column RAM puts the
// visible 128 columns at offset 2.
static void display_flush_pages(uint8_t first, uint8_t last) {
    if (!display.initialized) return;
    if (last >= display.pages) last = (uint8_t)(display.pages - 1);
    uint8_t buf[DISPLAY_MAX_WIDTH + 1];
    buf[0] = 0x40;   // data mode
    for (uint8_t p = first; p <= last; p++) {
        bool ok;
        if (display.controller == DISPLAY_CONTROLLER_SH1106) {
            uint8_t cmd[] = { 0x00, (uint8_t)(0xB0 | p), 0x02, 0x10 };
            ok = hal_i2c_write(display.addr, cmd, sizeof(cmd));
        } else {
            uint8_t cmd[] = { 0x00, 0x21, 0x00, (uint8_t)(display.width - 1), 0x22, p, p };
            ok = hal_i2c_write(display.addr, cmd, sizeof(cmd));
        }
        memcpy(buf + 1, &display.framebuffer[(uint16_t)p * display.width], display.width);
        ok = ok && hal_i2c_write(display.addr, buf, (size_t)display.width + 1);
        if (!ok) {
            display.initialized = false;   // so the idle screen doesn't retry it
            vm_fail("Hardware Error: display stopped responding");
            return;
        }
    }
}

static void display_flush(void) {
    display_flush_pages(0, (uint8_t)(display.pages - 1));
}

// Flush just the pages that rows y..y+h-1 touch.
static void display_flush_rows(int y, int h) {
    if (y >= display.height || h <= 0) return;
    if (y < 0) { h += y; y = 0; }
    display_flush_pages((uint8_t)(y / 8), (uint8_t)((y + h - 1) / 8));
}

// Find the display and work out what it is. Neither chip has an ID register,
// but the low nibble of the status byte tells them apart (the trick bitbank2's
// ss_oled uses): 0x8 = SH1106, 0x6 = SSD1306 128x64, 0x3 = SSD1306 128x32.
// 0x2 is a 0.91" 128x32 SSD1306 seen on real hardware (status 0x42, 0x02 once on).
// Some SSD1306 clones never answer reads, so presence is checked with a write
// (a NOP command) and an unreadable or unknown status keeps what the module
// declared. Reports what it settled on, since a guess can be wrong.
static bool display_answers(uint8_t addr, uint8_t *status, bool *read_ok) {
    const uint8_t nop[] = { 0x00, 0xE3 };   // command mode, NOP
    *read_ok = hal_i2c_read_reg(addr, 0x00, status, 1);
    return *read_ok || hal_i2c_write(addr, nop, sizeof(nop));
}

static bool display_detect(uint8_t addr, uint8_t alt) {
    uint8_t status = 0;
    bool read_ok = false;
    if (display_answers(addr, &status, &read_ok)) {
        display.addr = addr;
    } else if (alt && display_answers(alt, &status, &read_ok)) {
        display.addr = alt;
    } else {
        return false;
    }

    bool known = read_ok;
    switch (read_ok ? (status & 0x0F) : 0xFF) {
        case 0x8: display.controller = DISPLAY_CONTROLLER_SH1106;  display.height = 64; break;
        case 0x6: display.controller = DISPLAY_CONTROLLER_SSD1306; display.height = 64; break;
        case 0x2:
        case 0x3: display.controller = DISPLAY_CONTROLLER_SSD1306; display.height = 32; break;
        default:  known = false; break;
    }
    if (display.controller == DISPLAY_CONTROLLER_AUTO) display.controller = DISPLAY_CONTROLLER_SSD1306;

    char msg[96];
    snprintf(msg, sizeof(msg), "Screen: %s %ux%u at 0x%02X%s",
             display.controller == DISPLAY_CONTROLLER_SH1106 ? "SH1106" : "SSD1306",
             display.width, display.height, display.addr,
             known ? "" : read_ok ? " (guessed - status unrecognised)" : " (guessed - it doesn't report its type)");
    if (!known) {
        size_t n = strlen(msg);
        snprintf(msg + n, sizeof(msg) - n, " status=0x%02X", status);
    }
    hal_debug_println(msg);
    return true;
}

static bool display_init_ssd1306(void) {
    uint8_t mux = (uint8_t)(display.height - 1);
    uint8_t com_pins = (display.height == 64) ? 0x12 : 0x02;
    uint8_t cmds[] = {
        0x00,             // I2C control: command mode
        0xAE,             // Display OFF
        0xD5, 0x80,       // Clock divide ratio
        0xA8, mux,        // Multiplex ratio
        0xD3, 0x00,       // Display offset = 0
        0x40,             // Start line = 0
        0x8D, 0x14,       // Charge pump ON (internal Vcc)
        0x20, 0x00,       // Horizontal addressing mode
        0xA1,             // Segment remap (col 127 = SEG0)
        0xC8,             // COM scan direction remapped
        0xDA, com_pins,   // COM pins configuration
        0x81, 0xCF,       // Contrast
        0xD9, 0xF1,       // Pre-charge period
        0xDB, 0x40,       // VCOMH deselect level
        0xA4,             // Output follows RAM content
        0xA6,             // Normal display (not inverted)
        0xAF,             // Display ON
    };
    return hal_i2c_write(display.addr, cmds, sizeof(cmds));
}

static bool display_init_sh1106(void) {
    uint8_t cmds[] = {
        0x00,             // I2C control: command mode
        0xAE,             // Display OFF
        0xD5, 0x80,       // Clock divide ratio
        0xA8, 0x3F,       // Multiplex ratio: 64 rows
        0xD3, 0x00,       // Display offset = 0
        0x40,             // Start line = 0
        0xAD, 0x8B,       // DC-DC converter ON
        0xA1,             // Segment remap
        0xC8,             // COM scan direction remapped
        0xDA, 0x12,       // COM pins configuration
        0x81, 0xCF,       // Contrast
        0xD9, 0x1F,       // Pre-charge period
        0xDB, 0x40,       // VCOM deselect level
        0x32,             // Charge pump voltage 8.0V
        0xA4,             // Output follows RAM content
        0xA6,             // Normal display (not inverted)
        0xAF,             // Display ON
    };
    return hal_i2c_write(display.addr, cmds, sizeof(cmds));
}

// Idle screen, like CircuitPython's: once a program that used the screen
// stops (or errors, or ends leaving it blank), show a bolt, "Zapp" and why.
static void display_fill_bolt(int ox, int oy, int h) {
    // Bolt outline on a 10×16 grid, filled by an even-odd scanline test.
    static const int8_t px[] = { 3, 9, 6, 9, 2, 4, 1 };
    static const int8_t py[] = { 0, 0, 6, 6, 16, 9, 9 };
    const int n = sizeof(px);
    for (int y = 0; y < h; y++) {
        float gy = (y + 0.5f) * 16.0f / h;
        for (int x = 0; x < h; x++) {
            float gx = (x + 0.5f) * 16.0f / h;
            bool in = false;
            for (int i = 0, j = n - 1; i < n; j = i++)
                if ((py[i] > gy) != (py[j] > gy) &&
                    gx < (px[j] - px[i]) * (gy - py[i]) / (float)(py[j] - py[i]) + px[i])
                    in = !in;
            if (in) display_pixel(ox + x, oy + y, true);
        }
    }
}

static void display_idle_screen(const char *status) {
    if (!display.initialized) return;
    memset(display.framebuffer, 0, sizeof(display.framebuffer));
    display.cursor_y = 0;
    display_fill_bolt(2, 1, 30);
    display_draw_string(26, 2, 2, "Zapp");
    display_draw_string(80, 2, 1, "v" ZAPP_VERSION);
    if (display.height < 64) {
        display_draw_string(26, 22, 1, status);
    } else {
        // Room for the full message: wrap it at 21 characters a line.
        char line[22];
        for (int y = 36; *status && y + 8 <= display.height; y += 9) {
            size_t n = strlen(status);
            if (n > 21) {   // break at the last space that fits
                n = 21;
                while (n > 0 && status[n] != ' ') n--;
                if (n == 0) n = 21;
            }
            memcpy(line, status, n);
            line[n] = 0;
            display_draw_string(0, y, 1, line);
            status += n;
            while (*status == ' ') status++;
        }
    }
    display_flush();
}

static bool display_blank(void) {
    for (size_t i = 0; i < (size_t)display.pages * display.width; i++)
        if (display.framebuffer[i]) return false;
    return true;
}


void vm_init(void) {
    memset(&vm_ctx, 0, sizeof(vm_ctx));
    memset(&display, 0, sizeof(display));
}

void vm_run(const uint8_t *bytecode, uint16_t len) {
    vm_ctx.bc = bytecode;
    vm_ctx.bc_len = len;
    vm_ctx.ip = 0;
    vm_ctx.sp = 0;
    vm_ctx.call_depth = 0;
    vm_ctx.halted = false;
    vm_fail_msg[0] = 0;
    display.initialized = false;   // the last program's screen isn't this one's
    vm_rng_state ^= (uint32_t)hal_time_us() | 1u;   // random() differs run to run
    if (!vm_rng_state) vm_rng_state = 0x9E3779B9u;
    // vm_halt_signal is cleared by the caller (vm_clear_halt) before the run is
    // queued, so a stop request that arrives while we start up still counts.

    while (!vm_ctx.halted && vm_ctx.ip < vm_ctx.bc_len) {
        if (vm_halt_signal) break;
        hal_radio_poll();   // keep the network stack alive between instructions

        ZappOpcode op = (ZappOpcode)vm_ctx.bc[vm_ctx.ip++];

        switch (op) {
            case OP_HALT:
                vm_ctx.halted = true;
                break;
            case OP_I2C_INIT: {
                if (!vm_require_bytes(6)) break;
                uint8_t sda = vm_ctx.bc[vm_ctx.ip++];
                uint8_t scl = vm_ctx.bc[vm_ctx.ip++];
                uint32_t freq = vm_read_u32();
                hal_i2c_init(sda, scl, freq);
                break;
            }
            case OP_GPIO_WRITE: {
                if (!vm_require_bytes(2)) break;
                uint8_t pin = vm_pin_or_led(vm_ctx.bc[vm_ctx.ip++], true);
                if (vm_ctx.halted) break;
                uint8_t state = vm_ctx.bc[vm_ctx.ip++];
                if (pin == ZAPP_PIN_RADIO_LED) {
                    if (!hal_radio_led(state > 0)) vm_fail("Hardware Error: this board has no radio LED");
                    break;
                }
                hal_gpio_set_output(pin);
                hal_gpio_write(pin, state > 0);
                break;
            }
            case OP_GPIO_READ: {
                if (!vm_require_bytes(1)) break;
                uint8_t pin = vm_pin(vm_ctx.bc[vm_ctx.ip++]);
                if (vm_ctx.halted) break;
                hal_gpio_set_input(pin);
                ZappVal val = { .type = VAL_BOOL, .boolean = hal_gpio_read(pin) };
                vm_push(&vm_ctx, val);
                break;
            }
            case OP_I2C_READ: {
                if (!vm_require_bytes(3)) break;
                uint8_t addr = vm_ctx.bc[vm_ctx.ip++];
                uint8_t reg = vm_ctx.bc[vm_ctx.ip++];
                uint8_t len = vm_ctx.bc[vm_ctx.ip++];
                if (len > sizeof(((ZappVal *)0)->bytes.buf)) {
                    vm_fail("Hardware Error: I2C read length exceeds buffer");
                    break;
                }

                ZappVal raw = { .type = VAL_BYTES };
                raw.bytes.len = len;
                vm_last_i2c_addr = addr;   // chip-specific transforms read their calibration from it
                if (!hal_i2c_read_reg(addr, reg, raw.bytes.buf, len)) {
                    vm_fail("Hardware Error: I2C device not responding at address");
                    break;
                }
                vm_push(&vm_ctx, raw);
                break;
            }
            case OP_SLEEP_US: {
                if (!vm_require_bytes(4)) break;
                uint32_t us = vm_read_u32();
                // Long waits go in 10ms chunks so Ctrl+C still gets through.
                while (us > 10000 && !vm_halt_signal) {
                    hal_sleep_us(10000);
                    us -= 10000;
                }
                if (!vm_halt_signal) hal_sleep_us(us);
                break;
            }
            case OP_SLEEP_MS: {
                if (!vm_require_bytes(4)) break;
                uint32_t ms = vm_read_u32();
                // Sleep in 10ms chunks so halt requests stay responsive
                while (ms > 0 && !vm_halt_signal) {
                    uint32_t chunk = (ms > 10) ? 10 : ms;
                    hal_sleep_ms(chunk);
                    ms -= chunk;
                }
                break;
            }
            case OP_JUMP: {
                if (!vm_require_bytes(2)) break;
                vm_jump(vm_read_i16());
                break;
            }
            case OP_JUMP_IF_FALSE:
            case OP_JUMP_IF_TRUE: {
                if (!vm_require_bytes(2)) break;
                int16_t offset = vm_read_i16();
                bool cond = vm_truthy(vm_pop(&vm_ctx));
                if (vm_ctx.halted) break;
                if (cond == (op == OP_JUMP_IF_TRUE)) vm_jump(offset);
                break;
            }
            case OP_CALL: {
                if (!vm_require_bytes(3)) break;
                uint16_t addr = (uint16_t)((vm_ctx.bc[vm_ctx.ip] << 8) | vm_ctx.bc[vm_ctx.ip+1]);
                vm_ctx.ip += 3;   // addr(u16) + argc(u8); args are already on the stack
                if (vm_ctx.call_depth >= VM_CALL_DEPTH) {
                    vm_fail("VM Error: call stack overflow (recursion too deep)");
                    break;
                }
                if (addr >= vm_ctx.bc_len) {
                    vm_fail("VM Error: call to bad address");
                    break;
                }
                vm_ctx.call_stack[vm_ctx.call_depth++] = vm_ctx.ip;
                vm_ctx.ip = addr;
                break;
            }
            case OP_ENTER: {
                // first(u8) count(u8) argc(u8): stash the function's slots under
                // its arguments, so a recursive call can't clobber the caller's.
                if (!vm_require_bytes(3)) break;
                uint8_t first = vm_ctx.bc[vm_ctx.ip++];
                uint8_t count = vm_ctx.bc[vm_ctx.ip++];
                uint8_t argc  = vm_ctx.bc[vm_ctx.ip++];
                if ((uint32_t)first + count > VM_VAR_SLOTS || argc > vm_ctx.sp) {
                    vm_fail("VM Error: bad function frame");
                    break;
                }
                if ((uint32_t)vm_ctx.sp + count > VM_STACK_SIZE) {
                    vm_fail("VM Error: stack overflow (recursion too deep)");
                    break;
                }
                ZappVal *args = &vm_ctx.stack[vm_ctx.sp - argc];
                memmove(args + count, args, argc * sizeof(ZappVal));
                memcpy(args, &vm_ctx.vars[first], count * sizeof(ZappVal));
                vm_ctx.sp += count;
                break;
            }
            case OP_LEAVE: {
                // first(u8) count(u8): restore what OP_ENTER saved.
                if (!vm_require_bytes(2)) break;
                uint8_t first = vm_ctx.bc[vm_ctx.ip++];
                uint8_t count = vm_ctx.bc[vm_ctx.ip++];
                if ((uint32_t)first + count > VM_VAR_SLOTS || count > vm_ctx.sp) {
                    vm_fail("VM Error: bad function frame");
                    break;
                }
                vm_ctx.sp -= count;
                memcpy(&vm_ctx.vars[first], &vm_ctx.stack[vm_ctx.sp], count * sizeof(ZappVal));
                break;
            }
            case OP_RETURN: {
                if (vm_ctx.call_depth == 0) {
                    vm_ctx.halted = true;   // return from top level ends the program
                    break;
                }
                vm_ctx.ip = vm_ctx.call_stack[--vm_ctx.call_depth];
                break;
            }
            case OP_TRANSFORM: {
                if (!vm_require_bytes(1)) break;
                TransformId t_id = (TransformId)vm_ctx.bc[vm_ctx.ip++];
                ZappVal raw = vm_pop(&vm_ctx);   // bytes from a preceding I2C read
                ZappVal out = { .type = VAL_NIL };
                const uint8_t *b = raw.bytes.buf;
                uint8_t n = (raw.type == VAL_BYTES) ? raw.bytes.len : 0;

                // Two-byte views of the payload, big- and little-endian.
                int16_t be = (n >= 2) ? (int16_t)((b[0] << 8) | b[1]) : 0;
                int16_t le = (n >= 2) ? (int16_t)(b[0] | (b[1] << 8)) : 0;
                // BMP280 raw sample: 20-bit unsigned across 3 registers.
                int32_t adc20 = (n >= 3) ? (((int32_t)b[0] << 12) |
                                            ((int32_t)b[1] << 4)  |
                                            ((int32_t)b[2] >> 4)) : 0;

                switch (t_id) {
                    case TRANSFORM_RAW_U8:    if (n >= 1) out = vm_num((float)b[0]); break;
                    case TRANSFORM_RAW_U16_BE:if (n >= 2) out = vm_num((float)(uint16_t)be); break;
                    case TRANSFORM_RAW_U16_LE:if (n >= 2) out = vm_num((float)(uint16_t)le); break;
                    case TRANSFORM_RAW_I16_BE:
                    case TRANSFORM_TWOS_COMPLEMENT_16:
                        if (n >= 2) out = vm_num((float)be);
                        break;
                    case TRANSFORM_RAW_I16_LE:if (n >= 2) out = vm_num((float)le); break;
                    case TRANSFORM_SCALED_100:  if (n >= 2) out = vm_num((float)be / 100.0f); break;
                    case TRANSFORM_SCALED_1000: if (n >= 2) out = vm_num((float)be / 1000.0f); break;
                    case TRANSFORM_BCD_BYTE:  if (n >= 1) out = vm_num((float)bcd_to_dec(b[0])); break;
                    // Datasheet compensation with the chip's own calibration.
                    // Temperature: 3 bytes from 0xFA. Pressure: 6 bytes from
                    // 0xF7 (pressure then temperature, which it depends on).
                    case TRANSFORM_BMP280_TEMP: {
                        const Bmp280Calib *c = (n >= 3) ? bmp280_calib(vm_last_i2c_addr) : NULL;
                        if (c) out = vm_num((float)bmp280_temp_centi(c, adc20) / 100.0f);
                        break;
                    }
                    case TRANSFORM_BMP280_PRESSURE: {
                        // Modules before 1.1 read only the 3 pressure bytes; then
                        // the temperature field, read just before, has set t_fine.
                        const Bmp280Calib *c = (n >= 3) ? bmp280_calib(vm_last_i2c_addr) : NULL;
                        if (c) {
                            if (n >= 6) {
                                int32_t adc_t = ((int32_t)b[3] << 12) | ((int32_t)b[4] << 4) | ((int32_t)b[5] >> 4);
                                bmp280_temp_centi(c, adc_t);
                            }
                            out = vm_num((float)bmp280_pressure_q24_8(c, adc20) / 25600.0f);   // hPa
                        }
                        break;
                    }
                    // ±2g default → 16384 LSB/g; ±250°/s default → 131 LSB/°/s
                    case TRANSFORM_MPU6050_ACCEL: if (n >= 2) out = vm_num((float)be / 16384.0f); break;
                    case TRANSFORM_MPU6050_GYRO:  if (n >= 2) out = vm_num((float)be / 131.0f); break;
                    case TRANSFORM_DS3231_TIME:
                        if (n >= 3) {
                            out.type = VAL_STR;
                            out.str.len = (uint8_t)snprintf(out.str.buf, sizeof(out.str.buf),
                                "%02u:%02u:%02u", bcd_to_dec(b[2] & 0x3F),
                                bcd_to_dec(b[1] & 0x7F), bcd_to_dec(b[0] & 0x7F));
                        }
                        break;
                    case TRANSFORM_DS3231_DATE:
                        if (n >= 3) {
                            out.type = VAL_STR;
                            out.str.len = (uint8_t)snprintf(out.str.buf, sizeof(out.str.buf),
                                "%02u/%02u/20%02u", bcd_to_dec(b[0] & 0x3F),
                                bcd_to_dec(b[1] & 0x1F), bcd_to_dec(b[2]));
                        }
                        break;
                }
                vm_push(&vm_ctx, out);
                break;
            }
            case OP_STORE: {
                if (!vm_require_bytes(1)) break;
                uint8_t slot = vm_ctx.bc[vm_ctx.ip++];
                if (slot >= VM_VAR_SLOTS) {
                    vm_fail("VM Error: bad variable slot");
                    break;
                }
                vm_ctx.vars[slot] = vm_pop(&vm_ctx);
                break;
            }
            case OP_LOAD: {
                if (!vm_require_bytes(1)) break;
                uint8_t slot = vm_ctx.bc[vm_ctx.ip++];
                if (slot >= VM_VAR_SLOTS) {
                    vm_fail("VM Error: bad variable slot");
                    break;
                }
                vm_push(&vm_ctx, vm_ctx.vars[slot]);
                break;
            }
            case OP_PRINT: {
                ZappVal value = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                char buf[128];
                vm_format(value, buf, sizeof(buf));
                hal_debug_println(buf);
                break;
            }
            case OP_PRINT_STR: {
                if (!vm_require_bytes(1)) break;
                uint8_t len = vm_ctx.bc[vm_ctx.ip++];
                if (!vm_require_bytes(len)) break;
                char buf[256];
                uint8_t copy_len = (len < sizeof(buf) - 1) ? len : (uint8_t)(sizeof(buf) - 1);
                memcpy(buf, &vm_ctx.bc[vm_ctx.ip], copy_len);
                buf[copy_len] = '\0';
                vm_ctx.ip += len;
                hal_debug_println(buf);
                break;
            }
            // I2C write + scan
            case OP_I2C_WRITE: {
                if (!vm_require_bytes(3)) break;
                uint8_t addr = vm_ctx.bc[vm_ctx.ip++];
                uint8_t reg  = vm_ctx.bc[vm_ctx.ip++];
                uint8_t dlen = vm_ctx.bc[vm_ctx.ip++];
                if (!vm_require_bytes(dlen)) break;
                const uint8_t *data = &vm_ctx.bc[vm_ctx.ip];
                vm_ctx.ip += dlen;
                if (!hal_i2c_write_reg(addr, reg, data, dlen)) {
                    vm_fail("Hardware Error: I2C device not responding to write");
                }
                break;
            }
            case OP_I2C_SEND: case OP_I2C_RECV: {
                // send <data> to i2c <addr> [at <reg>]  /  read <n> bytes from i2c <addr> [at <reg>]
                if (!vm_require_bytes(1)) break;
                bool has_reg = vm_ctx.bc[vm_ctx.ip++] & 1;
                int32_t reg = has_reg ? vm_to_whole(vm_pop(&vm_ctx)) : 0;
                int32_t addr = vm_to_whole(vm_pop(&vm_ctx));
                ZappVal what = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                char msg[64];
                if (addr < 0 || addr > 127) { vm_fail("Hardware Error: an I2C address is 0-127 (0x00-0x7F)"); break; }
                if (reg < 0 || reg > 255)   { vm_fail("Hardware Error: an I2C register is 0-255"); break; }
                ZappVal out = { .type = VAL_BYTES };
                bool ok;
                if (op == OP_I2C_SEND) {
                    int n = vm_data_bytes(what, out.bytes.buf, sizeof(out.bytes.buf));
                    if (n < 0) break;
                    ok = has_reg ? hal_i2c_write_reg((uint8_t)addr, (uint8_t)reg, out.bytes.buf, (size_t)n)
                                 : hal_i2c_write((uint8_t)addr, out.bytes.buf, (size_t)n);
                } else {
                    int32_t n = vm_to_whole(what);
                    if (vm_ctx.halted) break;
                    if (n < 1 || n > (int32_t)sizeof(out.bytes.buf)) { vm_fail("Hardware Error: read 1-64 bytes at a time"); break; }
                    out.bytes.len = (uint8_t)n;
                    ok = has_reg ? hal_i2c_read_reg((uint8_t)addr, (uint8_t)reg, out.bytes.buf, (size_t)n)
                                 : hal_i2c_read((uint8_t)addr, out.bytes.buf, (size_t)n);
                }
                if (!ok) {
                    snprintf(msg, sizeof(msg), "Hardware Error: nothing answered at I2C address 0x%02X", (unsigned)addr);
                    vm_fail(msg);
                    break;
                }
                if (op == OP_I2C_RECV) vm_push(&vm_ctx, out);
                break;
            }
            case OP_I2C_SCAN: {
                uint8_t found[127];
                uint8_t count = 0;
                hal_i2c_scan(found, &count);
                char buf[128];
                if (count == 0) {
                    hal_debug_println("i2c: no devices found");
                } else {
                    int pos = 0;
                    for (uint8_t i = 0; i < count && pos < 120; i++) {
                        if (i > 0) buf[pos++] = ' ';
                        pos += snprintf(buf + pos, sizeof(buf) - (size_t)pos,
                                        "0x%02X", found[i]);
                    }
                    buf[pos] = '\0';
                    hal_debug_println(buf);
                }
                break;
            }

            // UART opcodes
            case OP_UART_INIT: {
                if (!vm_require_bytes(9)) break;
                uint8_t tx_pin = vm_ctx.bc[vm_ctx.ip++];
                uint8_t rx_pin = vm_ctx.bc[vm_ctx.ip++];
                uint32_t baud = vm_read_u32();
                uint8_t bits   = vm_ctx.bc[vm_ctx.ip++];
                uint8_t parity = vm_ctx.bc[vm_ctx.ip++];
                uint8_t stop   = vm_ctx.bc[vm_ctx.ip++];
                hal_uart_init(tx_pin, rx_pin, baud, bits, parity, stop);
                break;
            }
            case OP_UART_WRITE:
            case OP_UART_WRITE_STR: {
                if (!vm_require_bytes(1)) break;
                uint8_t wlen = vm_ctx.bc[vm_ctx.ip++];
                if (!vm_require_bytes(wlen)) break;
                hal_uart_write(&vm_ctx.bc[vm_ctx.ip], wlen);
                vm_ctx.ip += wlen;
                break;
            }
            case OP_UART_READ_BYTES: {
                if (!vm_require_bytes(5)) break;
                uint8_t max_len = vm_ctx.bc[vm_ctx.ip++];
                uint32_t timeout = vm_read_u32();
                ZappVal result = { .type = VAL_BYTES };
                if (max_len > sizeof(result.bytes.buf))
                    max_len = (uint8_t)sizeof(result.bytes.buf);
                result.bytes.len = hal_uart_read_bytes(
                    result.bytes.buf, max_len, timeout, &vm_halt_signal);
                vm_push(&vm_ctx, result);
                break;
            }
            case OP_UART_READ_LINE: {
                if (!vm_require_bytes(4)) break;
                uint32_t timeout = vm_read_u32();
                ZappVal result = { .type = VAL_STR };
                memset(result.str.buf, 0, sizeof(result.str.buf));
                bool ok = hal_uart_read_line(
                    result.str.buf,
                    (uint8_t)sizeof(result.str.buf),
                    timeout, &vm_halt_signal);
                if (ok) {
                    result.str.len = (uint8_t)strlen(result.str.buf);
                } else {
                    result.type = VAL_NIL;
                }
                vm_push(&vm_ctx, result);
                break;
            }
            case OP_UART_AVAILABLE: {
                ZappVal result = { .type = VAL_NUM };
                result.num = (float)hal_uart_available();
                vm_push(&vm_ctx, result);
                break;
            }
            case OP_UART_FLUSH: {
                hal_uart_flush();
                break;
            }
            case OP_UART_READ_UNTIL: {
                if (!vm_require_bytes(5)) break;
                uint8_t terminator = vm_ctx.bc[vm_ctx.ip++];
                uint32_t timeout = vm_read_u32();
                ZappVal result = { .type = VAL_STR };
                memset(result.str.buf, 0, sizeof(result.str.buf));
                bool ok = hal_uart_read_until(
                    result.str.buf,
                    (uint8_t)sizeof(result.str.buf),
                    terminator, timeout, &vm_halt_signal);
                if (ok) {
                    result.str.len = (uint8_t)strlen(result.str.buf);
                } else {
                    result.type = VAL_NIL;
                }
                vm_push(&vm_ctx, result);
                break;
            }
            case OP_UART_APPLY_PARSER: {
                if (!vm_require_bytes(1)) break;
                uint8_t parser_id = vm_ctx.bc[vm_ctx.ip++];
                ZappVal input = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;

                char line[80];
                vm_format(input, line, sizeof(line));
                const char *want = (parser_id == PARSER_NMEA_RMC_SPEED) ? "RMC" : "GGA";

                // A GPS interleaves sentence types, so the line we were handed
                // is usually not the one this field needs — read on until it is.
                for (int tries = 0; tries < 20 && !nmea_is(line, want); tries++) {
                    if (vm_halt_signal) break;
                    if (!hal_uart_read_line(line, (uint8_t)sizeof(line), 1000, &vm_halt_signal)) {
                        line[0] = '\0';
                        break;
                    }
                }

                ZappVal out = { .type = VAL_NIL };
                char field[16], hemi[4];
                if (nmea_is(line, want)) {
                    switch (parser_id) {
                        case PARSER_NMEA_GGA_LAT:
                            if (nmea_field(line, 2, field, sizeof(field)) &&
                                nmea_field(line, 3, hemi, sizeof(hemi)))
                                out = vm_num(nmea_degrees(field, hemi));
                            break;
                        case PARSER_NMEA_GGA_LON:
                            if (nmea_field(line, 4, field, sizeof(field)) &&
                                nmea_field(line, 5, hemi, sizeof(hemi)))
                                out = vm_num(nmea_degrees(field, hemi));
                            break;
                        case PARSER_NMEA_GGA_ALT:   // metres above mean sea level
                            if (nmea_field(line, 9, field, sizeof(field)))
                                out = vm_num(strtof(field, NULL));
                            break;
                        case PARSER_NMEA_GGA_FIX:
                            if (nmea_field(line, 6, field, sizeof(field)))
                                out = vm_bool(field[0] != '0');
                            break;
                        case PARSER_NMEA_RMC_SPEED: // knots, as the sentence reports it
                            if (nmea_field(line, 7, field, sizeof(field)))
                                out = vm_num(strtof(field, NULL));
                            break;
                        default:
                            out = input;   // unknown parser: hand the line back
                            break;
                    }
                }
                vm_push(&vm_ctx, out);
                break;
            }

            // Display opcodes
            case OP_DISPLAY_INIT: {
                // addr(u8) alt_addr(u8) width(u8) height(u8) controller(u8)
                if (!vm_require_bytes(5)) break;
                uint8_t addr = vm_ctx.bc[vm_ctx.ip++];
                uint8_t alt  = vm_ctx.bc[vm_ctx.ip++];
                display.width      = vm_ctx.bc[vm_ctx.ip++];
                display.height     = vm_ctx.bc[vm_ctx.ip++];
                display.controller = vm_ctx.bc[vm_ctx.ip++];
                if (display.width > DISPLAY_MAX_WIDTH) display.width = DISPLAY_MAX_WIDTH;
                if (!display_detect(addr, alt)) {
                    vm_fail("Hardware Error: no display found at 0x3C or 0x3D - check wiring and the i2c pins in config");
                    break;
                }
                display.pages = display.height / 8;
                if (display.pages > DISPLAY_MAX_PAGES) display.pages = DISPLAY_MAX_PAGES;
                display.cursor_y = 0;
                memset(display.framebuffer, 0, sizeof(display.framebuffer));
                bool ok = (display.controller == DISPLAY_CONTROLLER_SH1106)
                        ? display_init_sh1106() : display_init_ssd1306();
                if (!ok) {
                    vm_fail("Hardware Error: display did not accept its init commands");
                    break;
                }
                display.initialized = true;
                display_flush();
                break;
            }
            case OP_DISPLAY_CLEAR: {
                if (!display.initialized) break;
                memset(display.framebuffer, 0, sizeof(display.framebuffer));
                display.cursor_y = 0;
                display_flush();
                break;
            }
            case OP_DISPLAY_DRAW: {
                // x(u8) y(u8) size(u8) flags(u8) — pops the value to draw
                if (!vm_require_bytes(4)) break;
                int x = vm_ctx.bc[vm_ctx.ip++];
                int y = vm_ctx.bc[vm_ctx.ip++];
                uint8_t size  = vm_ctx.bc[vm_ctx.ip++];
                uint8_t flags = vm_ctx.bc[vm_ctx.ip++];
                ZappVal val = vm_pop(&vm_ctx);
                if (vm_ctx.halted || !display.initialized) break;
                char text[64];
                vm_format(val, text, sizeof(text));
                int h = 8 * (size ? size : 1);

                if (flags & DISPLAY_DRAW_AT_CURSOR) {
                    // Like a console: next line down, scrolling up when full.
                    x = 0;
                    if (display.cursor_y + h > display.height) {
                        int shift = (display.cursor_y + h - display.height + 7) / 8;   // pages
                        if (shift > display.pages) shift = display.pages;
                        memmove(display.framebuffer, &display.framebuffer[shift * display.width],
                                (size_t)(display.pages - shift) * display.width);
                        memset(&display.framebuffer[(display.pages - shift) * display.width], 0,
                               (size_t)shift * display.width);
                        display.cursor_y = (uint8_t)(display.cursor_y > shift * 8 ? display.cursor_y - shift * 8 : 0);
                        display_draw_string(x, display.cursor_y, size, text);
                        display_flush();
                    } else {
                        display_draw_string(x, display.cursor_y, size, text);
                        display_flush_rows(display.cursor_y, h);
                    }
                    y = display.cursor_y;
                    display.cursor_y = (uint8_t)(y + h);
                    break;
                }
                display_draw_string(x, y, size, text);
                display_flush_rows(y, h);
                break;
            }
            // Stack
            case OP_PUSH_NUM: {
                if (!vm_require_bytes(4)) break;
                union { uint32_t u; float f; } bits;
                bits.u = vm_read_u32();
                vm_push(&vm_ctx, vm_num(bits.f));
                break;
            }
            case OP_PUSH_INT: {
                if (!vm_require_bytes(4)) break;
                vm_push(&vm_ctx, vm_int((int32_t)vm_read_u32()));
                break;
            }
            case OP_PUSH_BOOL: {
                if (!vm_require_bytes(1)) break;
                vm_push(&vm_ctx, vm_bool(vm_ctx.bc[vm_ctx.ip++] != 0));
                break;
            }
            case OP_PUSH_STR: {
                if (!vm_require_bytes(1)) break;
                uint8_t slen = vm_ctx.bc[vm_ctx.ip++];
                if (!vm_require_bytes(slen)) break;
                ZappVal val = { .type = VAL_STR };
                val.str.len = (slen < sizeof(val.str.buf) - 1)
                            ? slen : (uint8_t)(sizeof(val.str.buf) - 1);
                memcpy(val.str.buf, &vm_ctx.bc[vm_ctx.ip], val.str.len);
                val.str.buf[val.str.len] = '\0';
                vm_ctx.ip += slen;
                vm_push(&vm_ctx, val);
                break;
            }
            case OP_POP:
                vm_pop(&vm_ctx);
                break;
            case OP_DUP:
                vm_push(&vm_ctx, vm_peek(&vm_ctx));
                break;

            // Arithmetic
            case OP_ADD: case OP_SUB: case OP_MUL: case OP_DIV: case OP_MOD:
            case OP_IDIV: case OP_POW: {
                ZappVal b = vm_pop(&vm_ctx);
                ZappVal a = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;

                // "+" on a string concatenates, so `print "temp: " + t` works.
                if (op == OP_ADD && (a.type == VAL_STR || b.type == VAL_STR)) {
                    char left[64], right[64];
                    vm_format(a, left, sizeof(left));
                    vm_format(b, right, sizeof(right));
                    ZappVal out = { .type = VAL_STR };
                    out.str.len = (uint8_t)snprintf(out.str.buf, sizeof(out.str.buf),
                                                    "%s%s", left, right);
                    if (out.str.len >= sizeof(out.str.buf)) {
                        out.str.len = (uint8_t)(sizeof(out.str.buf) - 1);
                    }
                    vm_push(&vm_ctx, out);
                    break;
                }
                ZappVal r = vm_arith(op, a, b);
                if (!vm_ctx.halted) vm_push(&vm_ctx, r);
                break;
            }
            case OP_BAND: case OP_BOR: case OP_BXOR: case OP_SHL: case OP_SHR: {
                ZappVal b = vm_pop(&vm_ctx);
                ZappVal a = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                ZappVal r = vm_bitop(op, a, b);
                if (!vm_ctx.halted) vm_push(&vm_ctx, r);
                break;
            }
            case OP_BNOT: {
                int32_t x = vm_to_whole(vm_pop(&vm_ctx));
                if (!vm_ctx.halted) vm_push(&vm_ctx, vm_int(~x));
                break;
            }
            case OP_TO_WHOLE: {
                int32_t x = vm_to_whole(vm_pop(&vm_ctx));
                if (!vm_ctx.halted) vm_push(&vm_ctx, vm_int(x));
                break;
            }
            case OP_TO_DECIMAL: {
                ZappVal a = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                if (a.type != VAL_INT && a.type != VAL_NUM && a.type != VAL_BOOL) {
                    vm_fail("VM Error: expected a number");
                    break;
                }
                vm_push(&vm_ctx, vm_num(vm_to_num(a)));
                break;
            }
            case OP_MATH: {
                if (!vm_require_bytes(1)) break;
                vm_math((MathFn)vm_ctx.bc[vm_ctx.ip++]);
                break;
            }

            // Comparison
            case OP_EQ: case OP_NEQ: {
                ZappVal b = vm_pop(&vm_ctx);
                ZappVal a = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                bool eq;
                if (a.type == VAL_STR || b.type == VAL_STR) {
                    char left[64], right[64];
                    vm_format(a, left, sizeof(left));
                    vm_format(b, right, sizeof(right));
                    eq = (a.type == b.type) && strcmp(left, right) == 0;
                } else if (a.type == VAL_BYTES || b.type == VAL_BYTES) {
                    eq = a.type == b.type && a.bytes.len == b.bytes.len &&
                         memcmp(a.bytes.buf, b.bytes.buf, a.bytes.len) == 0;
                } else if (a.type == VAL_NIL || b.type == VAL_NIL) {
                    eq = (a.type == b.type);
                } else {
                    eq = vm_compare(a, b) == 0;
                }
                vm_push(&vm_ctx, vm_bool(op == OP_EQ ? eq : !eq));
                break;
            }
            case OP_GT: case OP_LT: case OP_GTE: case OP_LTE: {
                ZappVal b = vm_pop(&vm_ctx);
                ZappVal a = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                int c = vm_compare(a, b);
                bool r = (op == OP_GT)  ? (c >  0)
                       : (op == OP_LT)  ? (c <  0)
                       : (op == OP_GTE) ? (c >= 0)
                                        : (c <= 0);
                vm_push(&vm_ctx, vm_bool(r));
                break;
            }

            // Bytes
            case OP_MAKE_BYTES: {
                if (!vm_require_bytes(1)) break;
                uint8_t n = vm_ctx.bc[vm_ctx.ip++];
                ZappVal out = { .type = VAL_BYTES };
                if (n > sizeof(out.bytes.buf)) { vm_fail("VM Error: too many bytes (64 max)"); break; }
                out.bytes.len = n;
                for (int k = n - 1; k >= 0 && !vm_ctx.halted; k--) {
                    int32_t b = vm_to_whole(vm_pop(&vm_ctx));
                    if (b < 0 || b > 255) vm_fail("VM Error: a byte is 0-255");
                    out.bytes.buf[k] = (uint8_t)b;
                }
                if (!vm_ctx.halted) vm_push(&vm_ctx, out);
                break;
            }
            case OP_INDEX: {
                ZappVal idx = vm_pop(&vm_ctx);
                ZappVal v = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                if (v.type == VAL_BYTES) {
                    int k = vm_index(idx, v.bytes.len);
                    if (k >= 0) vm_push(&vm_ctx, vm_int(v.bytes.buf[k]));
                } else if (v.type == VAL_STR) {
                    int k = vm_index(idx, v.str.len);
                    if (k < 0) break;
                    ZappVal out = { .type = VAL_STR };
                    out.str.buf[0] = v.str.buf[k];
                    out.str.buf[1] = '\0';
                    out.str.len = 1;
                    vm_push(&vm_ctx, out);
                } else {
                    vm_fail("VM Error: [ ] only works on bytes or text");
                }
                break;
            }
            case OP_SET_INDEX: {
                ZappVal val = vm_pop(&vm_ctx);
                ZappVal idx = vm_pop(&vm_ctx);
                ZappVal v = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                if (v.type != VAL_BYTES) { vm_fail("VM Error: set [ ] only works on bytes"); break; }
                int k = vm_index(idx, v.bytes.len);
                int32_t b = vm_to_whole(val);
                if (vm_ctx.halted) break;
                if (b < 0 || b > 255) { vm_fail("VM Error: a byte is 0-255"); break; }
                v.bytes.buf[k] = (uint8_t)b;
                vm_push(&vm_ctx, v);
                break;
            }
            case OP_LENGTH: {
                ZappVal v = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                if (v.type == VAL_BYTES)    vm_push(&vm_ctx, vm_int(v.bytes.len));
                else if (v.type == VAL_STR) vm_push(&vm_ctx, vm_int(v.str.len));
                else vm_fail("VM Error: length only works on bytes or text");
                break;
            }
            case OP_DECODE: {
                // `x as signed 16-bit [little endian]`: bytes (first bits/8 of
                // them) or a number (its low bits) read as an n-bit value.
                if (!vm_require_bytes(2)) break;
                uint8_t flags = vm_ctx.bc[vm_ctx.ip++];
                uint8_t bits = vm_ctx.bc[vm_ctx.ip++];
                ZappVal v = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                if (bits == 0 || bits > 32 || bits % 8) { vm_fail("VM Error: bad bit width"); break; }
                uint32_t word = 0;
                if (v.type == VAL_BYTES) {
                    uint8_t n = bits / 8;
                    if (v.bytes.len < n) {
                        char msg[64];
                        snprintf(msg, sizeof(msg), "VM Error: %u-bit needs %u bytes, got %u", bits, n, v.bytes.len);
                        vm_fail(msg);
                        break;
                    }
                    for (uint8_t k = 0; k < n; k++)
                        word |= (uint32_t)v.bytes.buf[(flags & 2) ? k : n - 1 - k] << (8 * k);
                } else {
                    word = (uint32_t)vm_to_whole(v);
                    if (vm_ctx.halted) break;
                }
                if (bits < 32) word &= (1u << bits) - 1;
                if (flags & 1) {
                    if (bits < 32 && (word & (1u << (bits - 1)))) word |= ~((1u << bits) - 1);
                    vm_push(&vm_ctx, vm_int((int32_t)word));
                } else {
                    vm_push(&vm_ctx, word <= INT32_MAX ? vm_int((int32_t)word) : vm_num((float)word));
                }
                break;
            }
            case OP_GET_BIT: {
                ZappVal v = vm_pop(&vm_ctx);
                int32_t n = vm_to_whole(vm_pop(&vm_ctx));
                int32_t x = vm_to_whole(v);
                if (vm_ctx.halted) break;
                if (n < 0 || n > 31) { vm_fail("VM Error: bit number is 0-31"); break; }
                vm_push(&vm_ctx, vm_bool((x >> n) & 1));
                break;
            }

            // Logic
            case OP_AND: case OP_OR: {
                ZappVal b = vm_pop(&vm_ctx);
                ZappVal a = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                bool r = (op == OP_AND) ? (vm_truthy(a) && vm_truthy(b))
                                        : (vm_truthy(a) || vm_truthy(b));
                vm_push(&vm_ctx, vm_bool(r));
                break;
            }
            case OP_NOT: {
                ZappVal a = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                vm_push(&vm_ctx, vm_bool(!vm_truthy(a)));
                break;
            }

            // PWM / servo / ADC
            case OP_PWM_SET: {
                if (!vm_require_bytes(4)) break;
                uint8_t pin  = vm_pin(vm_ctx.bc[vm_ctx.ip++]);
                if (vm_ctx.halted) break;
                uint8_t duty = vm_ctx.bc[vm_ctx.ip++];
                uint32_t freq = (uint32_t)((vm_ctx.bc[vm_ctx.ip] << 8) | vm_ctx.bc[vm_ctx.ip+1]);
                vm_ctx.ip += 2;
                hal_pwm_set(pin, duty, freq);
                break;
            }
            case OP_PWM_OFF: {
                if (!vm_require_bytes(1)) break;
                uint8_t pin = vm_pin(vm_ctx.bc[vm_ctx.ip++]);
                if (vm_ctx.halted) break;
                hal_pwm_disable(pin);
                break;
            }
            case OP_SERVO_SET: {
                if (!vm_require_bytes(3)) break;
                uint8_t pin = vm_pin(vm_ctx.bc[vm_ctx.ip++]);
                if (vm_ctx.halted) break;
                hal_servo_set(pin, vm_read_i16());
                break;
            }
            case OP_ADC_READ_RAW: {
                if (!vm_require_bytes(1)) break;
                uint8_t pin = vm_pin(vm_ctx.bc[vm_ctx.ip++]);
                if (vm_ctx.halted) break;
                hal_adc_init(pin);
                vm_push(&vm_ctx, vm_num((float)hal_adc_read_raw(pin)));
                break;
            }
            case OP_ADC_READ_VOLT: {
                if (!vm_require_bytes(1)) break;
                uint8_t pin = vm_pin(vm_ctx.bc[vm_ctx.ip++]);
                if (vm_ctx.halted) break;
                hal_adc_init(pin);
                vm_push(&vm_ctx, vm_num(hal_adc_read_voltage(pin)));
                break;
            }

            // NeoPixel
            case OP_NEO_SET: {
                if (!vm_require_bytes(6)) break;
                uint8_t pin = vm_ctx.bc[vm_ctx.ip++];
                uint16_t idx = (uint16_t)((vm_ctx.bc[vm_ctx.ip] << 8) | vm_ctx.bc[vm_ctx.ip+1]);
                vm_ctx.ip += 2;
                uint8_t r = vm_ctx.bc[vm_ctx.ip++];
                uint8_t g = vm_ctx.bc[vm_ctx.ip++];
                uint8_t bl = vm_ctx.bc[vm_ctx.ip++];
                hal_neopixel_set(pin, idx, r, g, bl);
                break;
            }
            case OP_NEO_SET_ALL: {
                if (!vm_require_bytes(4)) break;
                uint8_t pin = vm_ctx.bc[vm_ctx.ip++];
                uint8_t r = vm_ctx.bc[vm_ctx.ip++];
                uint8_t g = vm_ctx.bc[vm_ctx.ip++];
                uint8_t bl = vm_ctx.bc[vm_ctx.ip++];
                hal_neopixel_set_all(pin, r, g, bl);
                break;
            }
            case OP_NEO_BRIGHTNESS: {
                if (!vm_require_bytes(2)) break;
                uint8_t pin = vm_ctx.bc[vm_ctx.ip++];
                hal_neopixel_brightness(pin, vm_ctx.bc[vm_ctx.ip++]);
                break;
            }
            case OP_NEO_SHOW: {
                if (!vm_require_bytes(1)) break;
                hal_neopixel_show(vm_ctx.bc[vm_ctx.ip++]);
                break;
            }

            // SPI
            case OP_SPI_INIT: {
                if (!vm_require_bytes(9)) break;
                uint8_t mosi = vm_ctx.bc[vm_ctx.ip++];
                uint8_t miso = vm_ctx.bc[vm_ctx.ip++];
                uint8_t sck  = vm_ctx.bc[vm_ctx.ip++];
                uint8_t cs   = vm_ctx.bc[vm_ctx.ip++];
                uint32_t freq = vm_read_u32();
                uint8_t mode = vm_ctx.bc[vm_ctx.ip++];
                hal_spi_init(mosi, miso, sck, cs, freq, mode);
                break;
            }
            case OP_SPI_CS: {
                if (!vm_require_bytes(2)) break;
                uint8_t cs = vm_ctx.bc[vm_ctx.ip++];
                hal_spi_cs_set(cs, vm_ctx.bc[vm_ctx.ip++] != 0);
                break;
            }
            case OP_SPI_TRANSFER: {
                // cs(u8), tx_len(u8), tx[tx_len], rx_len(u8) -> bytes on stack
                if (!vm_require_bytes(2)) break;
                uint8_t cs = vm_ctx.bc[vm_ctx.ip++];
                uint8_t tx_len = vm_ctx.bc[vm_ctx.ip++];
                if (!vm_require_bytes((uint16_t)tx_len + 1)) break;
                const uint8_t *tx = &vm_ctx.bc[vm_ctx.ip];
                vm_ctx.ip += tx_len;
                uint8_t rx_len = vm_ctx.bc[vm_ctx.ip++];
                ZappVal out = { .type = VAL_BYTES };
                if (rx_len > sizeof(out.bytes.buf)) rx_len = (uint8_t)sizeof(out.bytes.buf);
                out.bytes.len = rx_len;
                hal_spi_transfer(cs, tx, tx_len, out.bytes.buf, rx_len);
                vm_push(&vm_ctx, out);
                break;
            }
            case OP_SPI_EXCHANGE: {
                // spi transfer <data> with cs <pin> -> what came back, same length
                if (!vm_require_bytes(1)) break;
                bool zeros = vm_ctx.bc[vm_ctx.ip++] & 1;   // read <n> bytes: send n zeros
                int32_t cs = vm_to_whole(vm_pop(&vm_ctx));
                ZappVal what = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                if (cs < 0 || cs >= ZAPP_GPIO_COUNT) { vm_fail("Hardware Error: pin number out of range"); break; }
                uint8_t tx[64] = { 0 };
                int n;
                if (zeros) {
                    n = vm_to_whole(what);
                    if (vm_ctx.halted) break;
                    if (n < 1 || n > (int)sizeof(tx)) { vm_fail("Hardware Error: read 1-64 bytes at a time"); break; }
                } else {
                    n = vm_data_bytes(what, tx, sizeof(tx));
                    if (n < 0) break;
                }
                ZappVal out = { .type = VAL_BYTES };
                out.bytes.len = (uint8_t)n;
                if (!hal_spi_exchange((uint8_t)cs, tx, out.bytes.buf, (uint8_t)n)) {
                    vm_fail("Hardware Error: SPI isn't set up");
                    break;
                }
                vm_push(&vm_ctx, out);
                break;
            }
            case OP_SPI_READ_FIELD: {
                // mask(u32), shift(u8), sign_bits(u8), scale(f32) — pops bytes
                if (!vm_require_bytes(10)) break;
                uint32_t mask = vm_read_u32();
                uint8_t shift = vm_ctx.bc[vm_ctx.ip++];
                uint8_t sign_bits = vm_ctx.bc[vm_ctx.ip++];
                union { uint32_t u; float f; } scale;
                scale.u = vm_read_u32();
                ZappVal raw = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;

                uint32_t word = 0;
                uint8_t n = (raw.type == VAL_BYTES) ? raw.bytes.len : 0;
                for (uint8_t i = 0; i < n && i < 4; i++) {
                    word = (word << 8) | raw.bytes.buf[i];   // MSB first
                }
                int32_t field = (int32_t)((word & mask) >> shift);
                if (sign_bits > 0 && sign_bits < 32) {
                    int32_t sign_bit = (int32_t)1 << (sign_bits - 1);
                    if (field & sign_bit) field -= (sign_bit << 1);
                }
                vm_push(&vm_ctx, vm_num((float)field * scale.f));
                break;
            }

            // HID
            case OP_HID_KEY: {
                if (!vm_require_bytes(2)) break;
                uint8_t modifier = vm_ctx.bc[vm_ctx.ip++];
                hal_hid_key(modifier, vm_ctx.bc[vm_ctx.ip++]);
                break;
            }
            case OP_HID_TYPE: {
                if (!vm_require_bytes(1)) break;
                uint8_t tlen = vm_ctx.bc[vm_ctx.ip++];
                if (!vm_require_bytes(tlen)) break;
                hal_hid_type((const char *)&vm_ctx.bc[vm_ctx.ip], tlen);
                vm_ctx.ip += tlen;
                break;
            }
            case OP_HID_MOUSE: {
                if (!vm_require_bytes(4)) break;
                int8_t dx = (int8_t)vm_ctx.bc[vm_ctx.ip++];
                int8_t dy = (int8_t)vm_ctx.bc[vm_ctx.ip++];
                uint8_t buttons = vm_ctx.bc[vm_ctx.ip++];
                hal_hid_mouse(dx, dy, buttons, (int8_t)vm_ctx.bc[vm_ctx.ip++]);
                break;
            }

            // Radio
            case OP_WIFI_CONNECT: {
                char ssid[33], password[65];
                if (!vm_read_inline_str(ssid, sizeof(ssid))) break;
                if (!vm_read_inline_str(password, sizeof(password))) break;
                if (!vm_radio_ready()) { vm_push(&vm_ctx, vm_bool(false)); break; }
                vm_push(&vm_ctx, vm_bool(hal_wifi_connect(ssid, password, 20000)));
                break;
            }
            case OP_WIFI_AP: {
                char ssid[33], password[65];
                if (!vm_read_inline_str(ssid, sizeof(ssid))) break;
                if (!vm_read_inline_str(password, sizeof(password))) break;
                if (!vm_radio_ready()) { vm_push(&vm_ctx, vm_bool(false)); break; }
                vm_push(&vm_ctx, vm_bool(hal_wifi_start_ap(ssid, password)));
                break;
            }
            case OP_WEB_SERVE:
                if (!vm_radio_ready()) { vm_push(&vm_ctx, vm_bool(false)); break; }
                vm_push(&vm_ctx, vm_bool(hal_web_serve()));
                break;
            case OP_WIFI_STATUS:
                vm_push(&vm_ctx, vm_bool(hal_radio_available() && hal_wifi_connected()));
                break;
            case OP_WIFI_IP: {
                ZappVal out = { .type = VAL_STR };
                hal_wifi_ip(out.str.buf, sizeof(out.str.buf));
                out.str.len = (uint8_t)strlen(out.str.buf);
                vm_push(&vm_ctx, out);
                break;
            }
            case OP_HTTP_GET:
            case OP_HTTP_POST: {
                char url[128], body[128];
                body[0] = '\0';
                if (!vm_read_inline_str(url, sizeof(url))) break;
                if (op == OP_HTTP_POST && !vm_read_inline_str(body, sizeof(body))) break;
                if (!vm_radio_ready()) { vm_push(&vm_ctx, vm_nil()); break; }

                ZappVal out = { .type = VAL_STR };
                int status = hal_http_request(op == OP_HTTP_GET ? "GET" : "POST", url,
                                              op == OP_HTTP_GET ? NULL : body,
                                              out.str.buf, sizeof(out.str.buf));
                if (status <= 0) {
                    hal_debug_println("Network Error: request failed");
                    vm_push(&vm_ctx, vm_nil());
                    break;
                }
                out.str.len = (uint8_t)strlen(out.str.buf);
                vm_push(&vm_ctx, out);
                break;
            }

            // Bluetooth Low Energy
            case OP_BLE_ADVERTISE: {
                char name[32];
                if (!vm_read_inline_str(name, sizeof(name))) break;
                if (!vm_ble_ready()) { vm_push(&vm_ctx, vm_bool(false)); break; }
                vm_push(&vm_ctx, vm_bool(hal_ble_advertise(name)));
                break;
            }
            case OP_BLE_NOTIFY: {
                ZappVal value = vm_pop(&vm_ctx);
                if (vm_ctx.halted) break;
                if (!vm_ble_ready()) { vm_push(&vm_ctx, vm_bool(false)); break; }
                char text[96];
                vm_format(value, text, sizeof(text));
                vm_push(&vm_ctx, vm_bool(hal_ble_notify(text)));
                break;
            }
            case OP_BLE_STATUS:
                vm_push(&vm_ctx, vm_bool(hal_ble_available() && hal_ble_connected()));
                break;
            case OP_BLE_MESSAGE: {
                ZappVal out = { .type = VAL_STR };
                if (!hal_ble_available() || !hal_ble_message(out.str.buf, sizeof(out.str.buf))) {
                    vm_push(&vm_ctx, vm_nil());
                    break;
                }
                out.str.len = (uint8_t)strlen(out.str.buf);
                vm_push(&vm_ctx, out);
                break;
            }

            default: {
                char buf[40];
                snprintf(buf, sizeof(buf), "VM Error: unknown opcode 0x%02X", op);
                vm_fail(buf);
                break;
            }
        }
    }

#ifndef ZAPP_EMULATOR   // the emulator's stop is its time limit: keep the last frame
    if (vm_halt_signal) display_idle_screen("Stopped");
#else
    if (vm_halt_signal) return;
#endif
    else if (vm_fail_msg[0]) display_idle_screen(display.height < 64 ? "Error: see output" : vm_fail_msg);
    else if (display.initialized && display_blank()) display_idle_screen("Code done running");
}

void vm_request_halt(void) {
    vm_halt_signal = true;
}

void vm_clear_halt(void) {
    vm_halt_signal = false;
}

void vm_push(VM *vm, ZappVal val) {
    if (vm->sp < VM_STACK_SIZE) {
        vm->stack[vm->sp++] = val;
    } else {
        vm_fail("VM Error: stack overflow");
    }
}

ZappVal vm_pop(VM *vm) {
    if (vm->sp > 0) {
        return vm->stack[--vm->sp];
    }
    vm_fail("VM Error: stack underflow");
    ZappVal nil_val = { .type = VAL_NIL };
    return nil_val;
}

ZappVal vm_peek(VM *vm) {
    if (vm->sp > 0) {
        return vm->stack[vm->sp - 1];
    }
    ZappVal nil_val = { .type = VAL_NIL };
    return nil_val;
}
