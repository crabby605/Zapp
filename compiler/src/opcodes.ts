// Bytecode opcodes — must match include/vm.h. tests/opcodes.test.ts parses
// vm.h and fails if the two ever drift apart.
export const OP = {
    GPIO_WRITE: 0x01,
    GPIO_READ: 0x02,
    PWM_SET: 0x03,
    PWM_OFF: 0x04,
    SERVO_SET: 0x05,
    ADC_READ_RAW: 0x06,
    ADC_READ_VOLT: 0x07,
    I2C_WRITE: 0x08,
    I2C_READ: 0x09,
    I2C_SCAN: 0x0A,
    TRANSFORM: 0x0B,
    I2C_INIT: 0x0C,
    I2C_SEND: 0x0D,
    I2C_RECV: 0x0E,
    SLEEP_US: 0x10,
    SLEEP_MS: 0x11,
    PUSH_NUM: 0x20,
    PUSH_BOOL: 0x21,
    PUSH_STR: 0x22,
    POP: 0x23,
    DUP: 0x24,
    PUSH_INT: 0x25,
    STORE: 0x30,
    LOAD: 0x31,
    ADD: 0x40,
    SUB: 0x41,
    MUL: 0x42,
    DIV: 0x43,
    MOD: 0x44,
    IDIV: 0x45,
    POW: 0x46,
    BAND: 0x47,
    BOR: 0x48,
    BXOR: 0x49,
    SHL: 0x4A,
    SHR: 0x4B,
    BNOT: 0x4C,
    TO_WHOLE: 0x4D,
    TO_DECIMAL: 0x4E,
    MATH: 0x4F,
    EQ: 0x50,
    NEQ: 0x51,
    GT: 0x52,
    LT: 0x53,
    GTE: 0x54,
    LTE: 0x55,
    MAKE_BYTES: 0x56,
    INDEX: 0x57,
    SET_INDEX: 0x58,
    LENGTH: 0x59,
    DECODE: 0x5A,
    GET_BIT: 0x5B,
    AND: 0x60,
    OR: 0x61,
    NOT: 0x62,
    JUMP: 0x70,
    JUMP_IF_FALSE: 0x71,
    JUMP_IF_TRUE: 0x72,
    CALL: 0x80,
    RETURN: 0x81,
    ENTER: 0x82,
    LEAVE: 0x83,
    PRINT: 0x90,
    PRINT_STR: 0x91,
    NEO_SET: 0xA0,
    NEO_SET_ALL: 0xA1,
    NEO_BRIGHTNESS: 0xA2,
    NEO_SHOW: 0xA3,
    SPI_INIT: 0xB0,
    SPI_TRANSFER: 0xB1,
    SPI_CS: 0xB2,
    SPI_READ_FIELD: 0xB3,
    SPI_EXCHANGE: 0xB4,
    UART_INIT: 0xC0,
    UART_WRITE: 0xC1,
    UART_WRITE_STR: 0xC2,
    UART_READ_BYTES: 0xC3,
    UART_READ_LINE: 0xC4,
    UART_AVAILABLE: 0xC5,
    UART_FLUSH: 0xC6,
    UART_READ_UNTIL: 0xC7,
    UART_APPLY_PARSER: 0xC8,
    DISPLAY_INIT: 0xD0,
    DISPLAY_CLEAR: 0xD1,
    DISPLAY_DRAW: 0xD4,
    HID_KEY: 0xE0,
    HID_TYPE: 0xE1,
    HID_MOUSE: 0xE2,
    WIFI_CONNECT: 0xF0,
    WIFI_STATUS: 0xF1,
    WIFI_IP: 0xF2,
    HTTP_GET: 0xF3,
    HTTP_POST: 0xF4,
    BLE_ADVERTISE: 0xF5,
    BLE_NOTIFY: 0xF6,
    BLE_STATUS: 0xF7,
    BLE_MESSAGE: 0xF8,
    WIFI_AP: 0xF9,
    WEB_SERVE: 0xFA,
    HALT: 0xFF,
} as const;

// Transform ids — must match the TransformId enum in firmware/core/vm.c.
export const TRANSFORM_IDS: Record<string, number> = {
    raw_u8: 0x00,
    raw_u16_be: 0x01,
    raw_u16_le: 0x02,
    raw_i16_be: 0x03,
    raw_i16_le: 0x04,
    scaled_100: 0x05,
    scaled_1000: 0x06,
    twos_complement_16: 0x07,
    bcd_byte: 0x08,
    bmp280_temp: 0x09,
    bmp280_pressure: 0x0A,
    ds3231_time: 0x0B,
    ds3231_date: 0x0C,
    mpu6050_accel: 0x0D,
    mpu6050_gyro: 0x0E,
};

// Stream parser ids — must match the PARSER_NMEA_* defines in firmware/core/vm.c.
export const PARSER_IDS: Record<string, number> = {
    nmea_gga_lat: 0x01,
    nmea_gga_lon: 0x02,
    nmea_gga_alt: 0x03,
    nmea_gga_fix: 0x04,
    nmea_rmc_speed: 0x05,
};

// HID modifier bits (usb_hid.h).
export const HID_MODIFIERS: Record<string, number> = {
    ctrl: 0x01, control: 0x01,
    shift: 0x02,
    alt: 0x04, option: 0x04,
    gui: 0x08, cmd: 0x08, command: 0x08, win: 0x08, super: 0x08,
};

export const HID_MOUSE_BUTTONS: Record<string, number> = {
    left: 0x01,
    right: 0x02,
    middle: 0x04,
};

// Named keys → HID usage ids. Letters and digits are computed, not listed.
export const HID_KEYS: Record<string, number> = {
    enter: 0x28, return: 0x28, escape: 0x29, esc: 0x29,
    backspace: 0x2A, tab: 0x2B, space: 0x2C, minus: 0x2D, equal: 0x2E,
    delete: 0x4C, home: 0x4A, end: 0x4D, pageup: 0x4B, pagedown: 0x4E,
    right: 0x4F, left: 0x50, down: 0x51, up: 0x52,
    f1: 0x3A, f2: 0x3B, f3: 0x3C, f4: 0x3D, f5: 0x3E, f6: 0x3F,
    f7: 0x40, f8: 0x41, f9: 0x42, f10: 0x43, f11: 0x44, f12: 0x45,
};

// One key name ("a", "enter", "f5") → HID usage id, or undefined.
export function hidKeycode(name: string): number | undefined {
    const key = name.toLowerCase();
    if (key.length === 1) {
        const c = key.charCodeAt(0);
        if (c >= 97 && c <= 122) return 0x04 + (c - 97);        // a-z
        if (c >= 49 && c <= 57) return 0x1E + (c - 49);         // 1-9
        if (c === 48) return 0x27;                              // 0
    }
    return HID_KEYS[key];
}
