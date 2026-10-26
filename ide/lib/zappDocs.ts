// One source of documentation for the language, used by hover, completion and
// the Guide. Keep in step with .claude/skills/zapp/SKILL.md.

export interface Doc {
    title: string;
    summary: string;     // plain words: what it does and when you'd want it
    syntax: string;      // the pattern; <angle brackets> are the parts you fill in
    example?: string;
}

export const DOCS: Record<string, Doc> = {
    print: {
        title: 'print', summary: 'Show a message or a value in the Output panel. The easiest way to see what your program is doing.',
        syntax: 'print <message or value>', example: 'print "Hello!"\nprint "Temperature: " + bmp280.temp',
    },
    sleep: {
        title: 'sleep', summary: 'Wait before doing the next thing. ms is thousandths of a second, s is seconds.',
        syntax: 'sleep <time>', example: 'sleep 500ms\nsleep 2s',
    },
    set: {
        title: 'set pin', summary: 'Turn a pin on (high) or off (low) — this is how you light an LED. Use a number, or a name from your board like LED.',
        syntax: 'set pin <pin> high\nset pin <pin> low', example: 'set pin LED high\nsleep 1s\nset pin LED low',
    },
    read: {
        title: 'read pin', summary: 'Check whether a pin is on or off — for example, whether a button is pressed. “read analog pin” gives a number for how much, like a dial or a light sensor.',
        syntax: 'read pin <pin>\nread analog pin <pin>',
        example: 'if read pin BUTTON:\n    print "pressed"\n\nnum knob = read analog pin A0',
    },
    pulse: {
        title: 'pulse', summary: 'Turn a pin partly on, for dimming an LED or setting a motor’s speed. 0 is off, 255 is fully on.',
        syntax: 'pulse <0 to 255> on pin <pin>', example: 'pulse 128 on pin 10    # about half brightness',
    },
    move: {
        title: 'move', summary: 'Turn a servo motor to an angle between -90 and 90 degrees. On boards that act as a USB mouse, it can also move the mouse.',
        syntax: 'move servo on pin <pin> to <angle>\nmove mouse <right> <down>',
        example: 'move servo on pin 12 to 45',
    },
    repeat: {
        title: 'repeat', summary: 'Do the indented lines again — a set number of times, or forever.',
        syntax: 'repeat <times>:\nrepeat forever:',
        example: 'repeat 3:\n    print "tick"\n\nrepeat forever:\n    set pin LED high\n    sleep 1s\n    set pin LED low\n    sleep 1s',
    },
    if: {
        title: 'if', summary: 'Only do the indented lines when something is true. Add else for what to do otherwise.',
        syntax: 'if <something is true>:\n    ...\nelse:\n    ...',
        example: 'if bmp280.temp > 30:\n    print "Too hot!"\nelse:\n    print "All good"',
    },
    func: {
        title: 'func', summary: 'Give a group of steps a name so you can use it again. The words after the name are the values you hand it.',
        syntax: 'func <name> <inputs>:', example: 'func blink times:\n    repeat times:\n        set pin LED high\n        sleep 100ms\n        set pin LED low\n        sleep 100ms\n\nblink 3',
    },
    num:  {
        title: 'num', summary: 'Remember a number under a name, to use or change later. / divides, // divides and drops the remainder, % gives the remainder.',
        syntax: 'num <name> = <number>', example: 'num count = 0\ncount = count + 1\nprint count',
    },
    text: { title: 'text', summary: 'Remember some words under a name.', syntax: 'text <name> = "<words>"', example: 'text name = "Zapp"\nprint "Hi " + name' },
    bool: { title: 'bool', summary: 'Remember a yes/no (true or false) under a name.', syntax: 'bool <name> = true', example: 'bool ready = false' },
    whole: { title: 'whole', summary: 'A number that never has a decimal point — anything after it is dropped.', syntax: 'whole <name> = <number>', example: 'whole steps = 2.7   # becomes 2' },
    decimal: { title: 'decimal', summary: 'A number that keeps its decimal point.', syntax: 'decimal <name> = <number>', example: 'decimal ratio = 1.5' },
    math: {
        title: 'maths', summary: 'Ready-made calculations: round a number, pick a random one, keep a value between limits, or rescale it — like turning a 0–65535 reading into 0–100.',
        syntax: 'round <value>   random(<low>, <high>)\nclamp(<value>, <low>, <high>)\nmap(<value>, <from low>, <from high>, <to low>, <to high>)',
        example: 'num dice = random(1, 6)\nnum percent = map(read analog pin A0, 0, 65535, 0, 100)\nprint round percent',
    },
    use: {
        title: 'use', summary: 'Add a sensor or screen to your program. Install it from the Module manager first; after that its readings have names like bmp280.temp.',
        syntax: 'use <module>', example: 'use bmp280',
    },
    get: {
        title: 'get data', summary: 'Take a fresh reading from a sensor. Do this before using its values.',
        syntax: 'get data from <module>', example: 'use bmp280\nget data from bmp280\nprint bmp280.temp',
    },
    display: {
        title: 'display', summary: 'Write on a small screen (OLED). Each line goes under the last; add “at x y” to place it yourself, or “size 2” to make it bigger.',
        syntax: 'display on <screen> <message> [at <x> <y>] [size <1 to 4>]',
        example: 'use oled\ndisplay on oled "Hello!" size 2',
    },
    clear: { title: 'clear', summary: 'Wipe a screen blank.', syntax: 'clear <screen>', example: 'clear oled' },
    show: {
        title: 'colour lights', summary: 'Light up NeoPixels (colour LEDs). Set the colours first, then show them.',
        syntax: 'set pixels on pin <pin> to <colour>\nshow pixels on pin <pin>',
        example: 'set pixels on pin NEOPIXEL to green\nshow pixels on pin NEOPIXEL',
    },
    config: {
        title: 'config', summary: 'Only needed if you wired a sensor to different pins than your board normally uses. Put it at the very top.',
        syntax: 'config:\n    i2c sda=<pin> scl=<pin>',
        example: 'config:\n    i2c sda=20 scl=21',
    },
    connect: {
        title: 'connect wifi', summary: 'Join your Wi-Fi network (boards with Wi-Fi, like the Pico W or ESP32-S3). Leave out “with” if the network has no password.',
        syntax: 'connect wifi to "<network>" with "<password>"',
        example: 'connect wifi to "homenet" with "secret123"\nif wifi connected:\n    print wifi ip',
    },
    startwifi: {
        title: 'start wifi', summary: 'Make the board its own Wi-Fi network that phones and laptops can join. Leave out “with” for no password.',
        syntax: 'start wifi "<network name>" with "<password>"', example: 'start wifi "Zapp" with "zapp1234"\nprint wifi ip',
    },
    serve: {
        title: 'serve web', summary: 'Show a web page from the board. Put the page in a web folder as index.html; anyone on the same network can open the board’s address in a browser.',
        syntax: 'serve web', example: 'start wifi "Zapp"\nserve web\nprint "open http://" + wifi ip',
    },
    wifi: { title: 'wifi', summary: '“wifi connected” is true once the board is on Wi-Fi; “wifi ip” is its address.', syntax: 'wifi connected\nwifi ip' },
    http: { title: 'http', summary: 'Ask a website for something, or send it a message. Only the first 63 characters of the answer are kept.', syntax: 'http get "<web address>"\nhttp post "<web address>" "<message>"', example: 'text reply = http get "http://example.com"' },
    advertise: { title: 'advertise', summary: 'Make the board show up in Bluetooth apps on your phone (try nRF Connect or LightBlue).', syntax: 'advertise "<name>"', example: 'advertise "my-sensor"' },
    notify: { title: 'notify', summary: 'Send a message to the phone connected over Bluetooth.', syntax: 'notify <message>', example: 'notify "temp " + bmp280.temp' },
    ble: { title: 'ble', summary: '“ble connected” is true while a phone is connected; “ble message” is the last thing it sent.', syntax: 'ble connected\nble message' },
    type: { title: 'type', summary: 'Type on the computer the board is plugged into, as if it were a keyboard.', syntax: 'type "<words>"', example: 'type "hello"' },
    press: { title: 'press', summary: 'Press keys on the computer, like a shortcut.', syntax: 'press "<keys>"', example: 'press "ctrl+c"' },
    click: { title: 'click', summary: 'Click the mouse on the computer.', syntax: 'click left', example: 'click left' },
    scroll: { title: 'scroll', summary: 'Scroll the page on the computer. Negative scrolls up.', syntax: 'scroll <amount>', example: 'scroll -2' },
    bytes: {
        title: 'bytes', summary: 'A short list of small numbers (0 to 255) — what chips send and expect. You only need this when talking to a chip directly.',
        syntax: 'bytes <name> = [<number>, ...]',
        example: 'bytes reply = [1, 255]\nprint reply[0]',
    },
    send: {
        title: 'send', summary: 'Send numbers straight to a chip. The chip’s datasheet tells you which numbers.',
        syntax: 'send <numbers> to i2c <chip address> [at <setting number>]\nsend <numbers> to spi with cs <pin>',
        example: 'send 0x27 to i2c 0x76 at 0xF4',
    },
    i2c: {
        title: 'read from i2c', summary: 'Ask an I2C chip for some numbers. I2C is the two-wire connection most sensors use; every chip on it has an address (its datasheet says which).',
        syntax: 'read <how many> bytes from i2c <chip address> [at <setting number>]',
        example: 'bytes raw = read 2 bytes from i2c 0x68 at 0x3B',
    },
    spi: {
        title: 'spi', summary: 'Swap numbers with an SPI chip — a faster connection used by some screens and memory chips. The cs pin picks which chip you mean.',
        syntax: 'spi transfer <numbers> with cs <pin>',
        example: 'bytes id = spi transfer [0x9F, 0, 0, 0] with cs 5\nprint id',
    },
    signed: {
        title: 'as signed', summary: 'Turn a pair of numbers from a chip into one reading. “signed” means it can be negative, like a tilt left or right.',
        syntax: '<numbers> as signed 16-bit',
        example: 'print [0xFF, 0x5C] as signed 16-bit   # -164',
    },
    bits: {
        title: 'bits', summary: 'Look at or combine the individual on/off parts of a number. 0x1F is a number written in hex, 0b1010 in binary.',
        syntax: 'bit <which> of <number>\n<a> & <b>   <a> | <b>   <a> << <places>',
        example: 'if bit 7 of status:\n    print "ready"',
    },
    forever: { title: 'forever', summary: 'Keep going until you press Stop.', syntax: 'repeat forever:' },
    pin: { title: 'pin', summary: 'One of the board’s connectors, by number or by a name like LED or A0.', syntax: 'pin <number or name>' },
    analog: { title: 'analog', summary: 'Read how much (not just on or off), from pins marked A0, A1…', syntax: 'read analog pin <pin>' },
};

// Sections for the guide, easiest first. `intro` is a line under the heading.
export const HELP_GROUPS: { title: string; intro?: string; keys: string[] }[] = [
    { title: 'Start here',          intro: 'A program runs from top to bottom. Indented lines belong to the line above them.', keys: ['print', 'sleep', 'set', 'repeat'] },
    { title: 'Lights, buttons and motors', keys: ['read', 'pulse', 'show', 'move'] },
    { title: 'Remembering things',  keys: ['num', 'text', 'bool', 'whole', 'decimal'] },
    { title: 'Decisions and loops', keys: ['if', 'func'] },
    { title: 'Sensors and screens', intro: 'Install the part’s module from the Module manager, then use it. No module for your I2C sensor? You can write one — see the last section.', keys: ['use', 'get', 'display', 'clear', 'config'] },
    { title: 'Maths',               keys: ['math'] },
    { title: 'Wi-Fi and Bluetooth', intro: 'Needs a board with a radio, like the Pico W or any ESP32-S3.', keys: ['connect', 'wifi', 'http', 'startwifi', 'serve', 'advertise', 'notify', 'ble'] },
    { title: 'Keyboard and mouse',  intro: 'The board pretends to be a keyboard or mouse for the computer it’s plugged into.', keys: ['type', 'press', 'click', 'scroll'] },
];

// Hover on any maths function or conversion word shows the shared entry.
for (const fn of ['abs', 'round', 'floor', 'ceil', 'sqrt', 'sin', 'cos', 'tan', 'min', 'max', 'clamp', 'map', 'random']) DOCS[fn] = DOCS.math!;
DOCS.unsigned = DOCS.signed!;
DOCS.bit = DOCS.bits!;
DOCS.transfer = DOCS.spi!;
