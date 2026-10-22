#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

// Zapp Bytecode VM

// Opcodes
typedef enum {
    // GPIO
    OP_GPIO_WRITE       = 0x01,  // pin(u8), state(u8)
    OP_GPIO_READ        = 0x02,  // pin(u8) -> stack

    // PWM
    OP_PWM_SET          = 0x03,  // pin(u8), duty(u8), freq_hi(u8), freq_lo(u8)
    OP_PWM_OFF          = 0x04,  // pin(u8)

    // Servo
    OP_SERVO_SET        = 0x05,  // pin(u8), angle_hi(u8), angle_lo(u8) (int16)

    // ADC
    OP_ADC_READ_RAW     = 0x06,  // pin(u8) -> stack
    OP_ADC_READ_VOLT    = 0x07,  // pin(u8) -> stack (float)

    // I2C
    OP_I2C_WRITE        = 0x08,  // addr(u8), reg(u8), len(u8), data[len]
    OP_I2C_READ         = 0x09,  // addr(u8), reg(u8), len(u8) -> stack[len]
    OP_I2C_SCAN         = 0x0A,  // -> prints found addresses
    OP_TRANSFORM        = 0x0B,  // NEW: Decode math logic handling
    OP_I2C_INIT         = 0x0C,  // sda(u8), scl(u8), freq(u32 big-endian)
    OP_I2C_SEND         = 0x0D,  // flags(u8: 1 = register) — pops data, addr[, reg]
    OP_I2C_RECV         = 0x0E,  // flags(u8: 1 = register) — pops count, addr[, reg] -> bytes

    // Timing
    OP_SLEEP_US         = 0x10,  // duration(u32 big-endian)
    OP_SLEEP_MS         = 0x11,  // duration(u32 big-endian)

    // Stack
    OP_PUSH_NUM         = 0x20,  // value(f32 big-endian)
    OP_PUSH_BOOL        = 0x21,  // value(u8) 0=false 1=true
    OP_PUSH_STR         = 0x22,  // len(u8), chars[len]
    OP_POP              = 0x23,
    OP_DUP              = 0x24,
    OP_PUSH_INT         = 0x25,  // value(i32 big-endian)

    // Variables (slot-based, 64 slots max)
    OP_STORE            = 0x30,  // slot(u8)
    OP_LOAD             = 0x31,  // slot(u8)

    // Arithmetic
    OP_ADD              = 0x40,
    OP_SUB              = 0x41,
    OP_MUL              = 0x42,
    OP_DIV              = 0x43,
    OP_MOD              = 0x44,  // floored, like Python: -1 % 3 = 2
    OP_IDIV             = 0x45,  // // : floored whole-number division
    OP_POW              = 0x46,  // **
    OP_BAND             = 0x47,  // &   bit operations work on whole numbers
    OP_BOR              = 0x48,  // |
    OP_BXOR             = 0x49,  // ^
    OP_SHL              = 0x4A,  // <<
    OP_SHR              = 0x4B,  // >>
    OP_BNOT             = 0x4C,  // ~
    OP_TO_WHOLE         = 0x4D,  // truncate toward zero (a `whole` variable)
    OP_TO_DECIMAL       = 0x4E,  // (a `decimal` variable)
    OP_MATH             = 0x4F,  // fn(u8) — see MathFn in vm.c

    // Comparison -> pushes bool
    OP_EQ               = 0x50,
    OP_NEQ              = 0x51,
    OP_GT               = 0x52,
    OP_LT               = 0x53,
    OP_GTE              = 0x54,
    OP_LTE              = 0x55,

    // Bytes
    OP_MAKE_BYTES       = 0x56,  // count(u8) — pops count values (0-255) -> bytes
    OP_INDEX            = 0x57,  // pops index, bytes|text -> item
    OP_SET_INDEX        = 0x58,  // pops value, index, bytes -> new bytes
    OP_LENGTH           = 0x59,  // pops bytes|text -> whole
    OP_DECODE           = 0x5A,  // flags(u8: 1 signed, 2 little-endian), bits(u8) — pops bytes|num
    OP_GET_BIT          = 0x5B,  // pops value, bit number -> bool

    // Logic
    OP_AND              = 0x60,
    OP_OR               = 0x61,
    OP_NOT              = 0x62,

    // Control flow
    OP_JUMP             = 0x70,  // offset(i16 big-endian) relative to next instr
    OP_JUMP_IF_FALSE    = 0x71,  // offset(i16) — pops bool, jumps if false
    OP_JUMP_IF_TRUE     = 0x72,  // offset(i16) — pops bool, jumps if true

    // Functions
    OP_CALL             = 0x80,  // addr(u16 big-endian), argc(u8)
    OP_RETURN           = 0x81,
    OP_ENTER            = 0x82,  // first(u8), count(u8), argc(u8) — save slots under args
    OP_LEAVE            = 0x83,  // first(u8), count(u8) — restore saved slots

    // I/O
    OP_PRINT            = 0x90,  // pops top of stack, sends over USB CDC
    OP_PRINT_STR        = 0x91,  // len(u8), chars[len] — inline string

    // NeoPixel
    OP_NEO_SET          = 0xA0,  // pin(u8), index(u16), r(u8), g(u8), b(u8)
    OP_NEO_SET_ALL      = 0xA1,  // pin(u8), r(u8), g(u8), b(u8)
    OP_NEO_BRIGHTNESS   = 0xA2,  // pin(u8), brightness(u8)
    OP_NEO_SHOW         = 0xA3,  // pin(u8)

    // SPI
    OP_SPI_INIT         = 0xB0,
    OP_SPI_TRANSFER     = 0xB1,
    OP_SPI_CS           = 0xB2,
    OP_SPI_READ_FIELD   = 0xB3,
    OP_SPI_EXCHANGE     = 0xB4,  // flags(u8: 1 = data is a count of zeros) — pops data, cs -> bytes

    // UART
    OP_UART_INIT         = 0xC0,
    OP_UART_WRITE        = 0xC1,
    OP_UART_WRITE_STR    = 0xC2,
    OP_UART_READ_BYTES   = 0xC3,
    OP_UART_READ_LINE    = 0xC4,
    OP_UART_AVAILABLE    = 0xC5,
    OP_UART_FLUSH        = 0xC6,
    OP_UART_READ_UNTIL   = 0xC7,
    OP_UART_APPLY_PARSER = 0xC8,

    // Display (SSD1306 etc.)
    OP_DISPLAY_INIT      = 0xD0,  // addr(u8), alt_addr(u8), width(u8), height(u8), controller(u8)
    OP_DISPLAY_CLEAR     = 0xD1,  // zeros framebuffer + flushes
    OP_DISPLAY_DRAW      = 0xD4,  // x(u8), y(u8), size(u8), flags(u8) — pops value, draws + flushes

    // HID (USB keyboard + mouse)
    OP_HID_KEY          = 0xE0,  // modifier(u8), keycode(u8)
    OP_HID_TYPE         = 0xE1,  // len(u8), chars[len]
    OP_HID_MOUSE        = 0xE2,  // dx(i8), dy(i8), buttons(u8), scroll(i8)

    // Radio (Wi-Fi / HTTP) — only on boards with a radio
    OP_WIFI_CONNECT     = 0xF0,  // ssid_len(u8), ssid, pass_len(u8), pass -> bool
    OP_WIFI_STATUS      = 0xF1,  // -> bool
    OP_WIFI_IP          = 0xF2,  // -> str
    OP_HTTP_GET         = 0xF3,  // url_len(u8), url -> str (nil on failure)
    OP_HTTP_POST        = 0xF4,  // url_len(u8), url, body_len(u8), body -> str

    // Bluetooth Low Energy (peripheral, Nordic UART service)
    OP_BLE_ADVERTISE    = 0xF5,  // name_len(u8), name -> bool
    OP_BLE_NOTIFY       = 0xF6,  // pops a value, sends it as text -> bool
    OP_BLE_STATUS       = 0xF7,  // -> bool (a central is connected)
    OP_BLE_MESSAGE      = 0xF8,  // -> str, or nil when nothing was received
    OP_WIFI_AP          = 0xF9,  // ssid_len(u8), ssid, pass_len(u8), pass -> bool
    OP_WEB_SERVE        = 0xFA,  // serve the drive's web/ folder on port 80 -> bool

    // VM control
    OP_HALT             = 0xFF,
} ZappOpcode;

// Value types on the stack
typedef enum {
    VAL_NUM  = 0,
    VAL_BOOL = 1,
    VAL_STR  = 2,
    VAL_NIL  = 3,
    VAL_BYTES = 4,
    VAL_INT  = 5,   // a whole number; `num` arithmetic keeps these exact
} ValType;

typedef struct {
    ValType type;
    union {
        float   num;
        int32_t i;
        bool    boolean;
        struct {
            char    buf[64];
            uint8_t len;
        } str;
        struct {
            uint8_t buf[64];   // as big as text, so a value doesn't grow
            uint8_t len;
        } bytes;
    };
} ZappVal;

// VM state
#define VM_STACK_SIZE   64
#define VM_VAR_SLOTS    64
#define VM_CALL_DEPTH   16

typedef struct {
    // Execution
    const uint8_t  *bc;
    uint16_t        bc_len;
    uint16_t        ip;

    // Stack
    ZappVal         stack[VM_STACK_SIZE];
    uint8_t         sp;

    // Variables
    ZappVal         vars[VM_VAR_SLOTS];

    // Call stack
    uint16_t        call_stack[VM_CALL_DEPTH];
    uint8_t         call_depth;

    // State
    volatile bool   halted;
} VM;

// API
void vm_init(void);
void vm_run(const uint8_t *bytecode, uint16_t len);
void vm_request_halt(void);
void vm_clear_halt(void);   // call before queuing a run

// Stack helpers (used by opcode handlers)
void     vm_push(VM *vm, ZappVal val);
ZappVal  vm_pop(VM *vm);
ZappVal  vm_peek(VM *vm);
