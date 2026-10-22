// One source of documentation for the language, used by hover, completion and
// the Help view. Keep in step with .claude/skills/zapp/SKILL.md.

export interface Doc {
    title: string;
    summary: string;
    syntax: string;
    example?: string;
}

export const DOCS: Record<string, Doc> = {
    config: {
        title: 'config', summary: 'Bus and radio setup. Must come before the modules that need it.',
        syntax: 'config:\n    i2c sda=<pin> scl=<pin>',
        example: 'config:\n    i2c sda=20 scl=21\n    uart tx=0 rx=1 baud=9600',
    },
    use: {
        title: 'use', summary: 'Load a sensor or display module from modules/*.zappmod.',
        syntax: 'use <module>', example: 'use bmp280',
    },
    set: {
        title: 'set pin', summary: 'Drive a GPIO pin high or low.',
        syntax: 'set pin <pin> high|low', example: 'set pin 25 high',
    },
    read: {
        title: 'read', summary: 'Read a pin. As a statement it prints; in an expression it yields a value.',
        syntax: 'read pin <pin>\nread analog pin <pin> [as voltage]',
        example: 'if read pin 15:\n    print "pressed"',
    },
    pulse: {
        title: 'pulse', summary: 'PWM output. Duty is 0-255; a duty of 0 turns the pin off.',
        syntax: 'pulse <duty> on pin <pin> [at <freq>hz]', example: 'pulse 128 on pin 10 at 1000hz',
    },
    move: {
        title: 'move', summary: 'Set a servo angle (-90 to 90), or move the USB mouse.',
        syntax: 'move servo on pin <pin> to <angle>\nmove mouse <dx> <dy>',
        example: 'move servo on pin 12 to -45',
    },
    sleep: {
        title: 'sleep', summary: 'Pause. Halt requests are still honoured while sleeping.',
        syntax: 'sleep <n>ms | <n>s | <n>us', example: 'sleep 500ms',
    },
    repeat: {
        title: 'repeat', summary: 'Loop a fixed number of times, a variable number of times, or forever.',
        syntax: 'repeat <count>:\nrepeat forever:',
        example: 'repeat 3:\n    print "tick"',
    },
    if: {
        title: 'if', summary: 'Run a block when a condition holds; else runs when it does not.',
        syntax: 'if <condition>:\n    ...\nelse:\n    ...',
        example: 'if bmp280.temp > 30:\n    set pin 25 high',
    },
    func: {
        title: 'func', summary: 'Define a function with positional parameters. Call it by name.',
        syntax: 'func <name> <param> ...:', example: 'func blink pin times:\n    repeat times:\n        set pin pin high\n        sleep 100ms\n        set pin pin low\n        sleep 100ms\n\nblink 25 3',
    },
    get: {
        title: 'get data', summary: 'Read every field of a module into module.field.',
        syntax: 'get data from <module>', example: 'get data from bmp280\nprint bmp280.temp',
    },
    print: {
        title: 'print', summary: 'Send a value to the serial console.',
        syntax: 'print <expression>', example: 'print "temp " + bmp280.temp',
    },
    display: {
        title: 'display', summary: 'Draw text or a value on an OLED. Without `at` it goes on the next line down and scrolls when full; `at x y` places it in pixels; `size` scales it 1-4x. Text replaces whatever is to its right.',
        syntax: 'display on <display> <text|expression> [at <x> <y>] [size <n>]',
        example: 'display on oled "Temp: " + bmp280.temp at 0 0 size 2',
    },
    show: {
        title: 'show pixels', summary: 'Send the colours you set to the NeoPixels.',
        syntax: 'show pixels on pin <pin>',
        example: 'set pixels on pin NEOPIXEL to green\nshow pixels on pin NEOPIXEL',
    },
    clear: { title: 'clear', summary: 'Blank a display.', syntax: 'clear <display>', example: 'clear oled' },
    num:  {
        title: 'num', summary: 'A number. Whole numbers stay exact (up to ±2.1 billion); decimals have 7 digits. / gives the real answer, // whole-number division, % the remainder, ** power.',
        syntax: 'num <name> = <expression>', example: 'num count = 0\nprint 7 / 2     # 3.5\nprint 7 // 2    # 3\nprint 2 ** 10   # 1024',
    },
    whole: { title: 'whole', summary: 'A number that is always whole: decimals stored in it lose their fraction.', syntax: 'whole <name> = <expression>', example: 'whole steps = 2.7   # 2' },
    decimal: { title: 'decimal', summary: 'A number that is always a decimal.', syntax: 'decimal <name> = <expression>', example: 'decimal ratio = 1' },
    bytes: {
        title: 'bytes', summary: 'Up to 64 bytes (0-255 each), for talking to chips. x[0] is the first, x[-1] the last.',
        syntax: 'bytes <name> = [<byte>, ...]',
        example: 'bytes reply = [0x01, 0xFF]\nprint reply[0]\nset reply[1] to 0\nprint length of reply',
    },
    math: {
        title: 'maths', summary: 'abs round floor ceil sqrt sin cos tan (degrees) · min max clamp map · random(lo, hi). One value: brackets optional.',
        syntax: 'abs(x)  round x  min(a, b)  clamp(x, lo, hi)\nmap(x, from_lo, from_hi, to_lo, to_hi)  random(1, 6)',
        example: 'num dice = random(1, 6)\nnum percent = map(read analog pin 26, 0, 65535, 0, 100)\nprint round percent',
    },
    bits: {
        title: 'bits', summary: 'Bit operators on whole numbers: & | ^ ~ << >>. 0x1F is hex, 0b1010 binary.',
        syntax: 'a & b  a | b  a ^ b  ~a  a << n  a >> n\nbit <n> of <value>',
        example: 'num value = (raw[0] << 8) | raw[1]\nif bit 7 of status:\n    print "ready"',
    },
    send: {
        title: 'send', summary: 'Write bytes to a chip. A register goes after `at`; SPI chips are picked by their cs pin.',
        syntax: 'send <data> to i2c <address> [at <register>]\nsend <data> to spi with cs <pin>',
        example: 'send 0x27 to i2c 0x76 at 0xF4\nsend [0x06] to spi with cs 5',
    },
    i2c: {
        title: 'i2c', summary: 'Read straight from an I2C chip. The bus uses the board\'s SDA/SCL unless config says otherwise.',
        syntax: 'read <n> bytes from i2c <address> [at <register>]',
        example: 'num ax = read 2 bytes from i2c 0x68 at 0x3B as signed 16-bit',
    },
    spi: {
        title: 'spi', summary: 'Talk to an SPI chip: transfer sends bytes and gives back what came in at the same time.',
        syntax: 'spi transfer <data> with cs <pin>\nread <n> bytes from spi with cs <pin>',
        example: 'bytes id = spi transfer [0x9F, 0, 0, 0] with cs 5\nprint id',
    },
    signed: {
        title: 'as signed/unsigned', summary: 'Read bytes (or a number\'s low bits) as an 8/16/24/32-bit value. Big endian unless you say little.',
        syntax: '<value> as signed|unsigned <8|16|24|32>-bit [big|little endian]',
        example: 'print [0xFF, 0x5C] as signed 16-bit   # -164',
    },
    text: { title: 'text', summary: 'Declare a text variable.',    syntax: 'text <name> = "<value>"',    example: 'text name = "zapp"' },
    bool: { title: 'bool', summary: 'Declare a true/false variable.', syntax: 'bool <name> = true|false', example: 'bool ready = true' },
    type: { title: 'type', summary: 'Type text on the host computer as a USB keyboard.', syntax: 'type "<text>"', example: 'type "hello"' },
    press: { title: 'press', summary: 'Press a key combo as a USB keyboard.', syntax: 'press "<combo>"', example: 'press "ctrl+c"' },
    click: { title: 'click', summary: 'Click the USB mouse.', syntax: 'click left|right|middle', example: 'click left' },
    scroll: { title: 'scroll', summary: 'Scroll the USB mouse.', syntax: 'scroll <amount>', example: 'scroll -2' },
    connect: { title: 'connect wifi', summary: 'Join a Wi-Fi network (Pico W). Leave out `with` for an open network.', syntax: 'connect wifi to "<network>" with "<password>"', example: 'connect wifi to "homenet" with "secret123"\nif wifi connected:\n    print wifi ip' },
    wifi: { title: 'wifi', summary: 'wifi connected → true when joined; wifi ip → the address as text.', syntax: 'wifi connected | wifi ip' },
    http: { title: 'http', summary: 'Fetch a url over plain HTTP. Responses are truncated to 63 bytes.', syntax: 'http get "<url>"\nhttp post "<url>" "<body>"', example: 'text page = http get "http://example.com"' },
    advertise: { title: 'advertise', summary: 'Start advertising as a BLE peripheral (Nordic UART service).', syntax: 'advertise "<name>"', example: 'advertise "zapp-sensor"' },
    notify: { title: 'notify', summary: 'Send a value to the connected BLE central.', syntax: 'notify <expression>', example: 'notify "temp " + bmp280.temp' },
    ble: { title: 'ble', summary: 'ble connected → true when a central is attached; ble message → what it sent, or nil.', syntax: 'ble connected | ble message' },
    forever: { title: 'forever', summary: 'Loop until the board is stopped (Ctrl+C).', syntax: 'repeat forever:' },
    pin: { title: 'pin', summary: 'A GPIO number, or a variable holding one.', syntax: 'pin <number>' },
    analog: { title: 'analog', summary: 'Read an ADC pin (GP26-29 on RP2040).', syntax: 'read analog pin <pin> [as voltage]' },
};

// Groups for the Help view, in teaching order.
export const HELP_GROUPS: { title: string; keys: string[] }[] = [
    { title: 'Pins',        keys: ['set', 'read', 'pulse', 'move'] },
    { title: 'Program',     keys: ['num', 'whole', 'decimal', 'text', 'bool', 'print', 'sleep'] },
    { title: 'Maths',       keys: ['math', 'bits'] },
    { title: 'Flow',        keys: ['repeat', 'if', 'func'] },
    { title: 'Peripherals', keys: ['config', 'use', 'get', 'display', 'show', 'clear'] },
    { title: 'Talk to chips', keys: ['bytes', 'send', 'i2c', 'spi', 'signed'] },
    { title: 'USB HID',     keys: ['type', 'press', 'click', 'scroll'] },
    { title: 'Radio',       keys: ['connect', 'wifi', 'http', 'advertise', 'notify', 'ble'] },
];

// Hover on any maths function or conversion word shows the shared entry.
for (const fn of ['abs', 'round', 'floor', 'ceil', 'sqrt', 'sin', 'cos', 'tan', 'min', 'max', 'clamp', 'map', 'random']) DOCS[fn] = DOCS.math!;
DOCS.unsigned = DOCS.signed!;
DOCS.bit = DOCS.bits!;
DOCS.transfer = DOCS.spi!;
