import { BoardDefinition, Indicator } from './board';
import { Token, TokenType } from './lexer';
import { OP, TRANSFORM_IDS, PARSER_IDS, HID_MODIFIERS, HID_MOUSE_BUTTONS, hidKeycode } from './opcodes';

// Ids match DISPLAY_CONTROLLER_* in src/vm.c. The firmware detects the real
// chip at startup; this is only the fallback if detection can't tell.
const DISPLAY_CONTROLLERS: Record<string, number> = {
    auto: 0x00,
    ssd1306: 0x01,
    sh1106: 0x02,
};
const DISPLAY_AT_CURSOR = 0x01;   // OP_DISPLAY_DRAW flag

// `set pixels on pin NEOPIXEL to orange` — names for `r g b`.
const COLORS: Record<string, [number, number, number]> = {
    red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255],
    white: [255, 255, 255], yellow: [255, 180, 0], orange: [255, 80, 0],
    cyan: [0, 255, 255], purple: [160, 0, 255], magenta: [255, 0, 255],
    pink: [255, 60, 120], off: [0, 0, 0], black: [0, 0, 0],
};

// abs(x), min(a, b)... Ids match MathFn in src/vm.c. One-argument functions
// also work without brackets: `round temp`.
const MATH_FUNCTIONS: Record<string, { id: number; argc: number }> = {
    abs: { id: 0, argc: 1 }, round: { id: 1, argc: 1 }, floor: { id: 2, argc: 1 },
    ceil: { id: 3, argc: 1 }, sqrt: { id: 4, argc: 1 },
    sin: { id: 5, argc: 1 }, cos: { id: 6, argc: 1 }, tan: { id: 7, argc: 1 },   // degrees
    min: { id: 8, argc: 2 }, max: { id: 9, argc: 2 }, clamp: { id: 10, argc: 3 },
    map: { id: 11, argc: 5 }, random: { id: 12, argc: 2 },
};

// `whole` and `decimal` variables convert whatever is stored in them.
type VariableKind = 'whole' | 'decimal';
const DECLARATION_WORDS = new Set(['whole', 'decimal', 'bytes']);

// Pin operand 0xFF means "pop the pin from the stack" — lets a pin come from a
// variable or function parameter. GP255 doesn't exist, so it's free to use.
const PIN_FROM_STACK = 0xFF;
const NO_CS = 0xFF;   // SPI set up without a default chip select

export interface ModuleFieldDefinition {
    reg: number;
    len: number;
    transform: string;
    type?: string;
    // UART module fields
    read?: string;       // "line" | "bytes" | "until"
    filter?: string;     // e.g. "$GPGGA"
    parse?: string;      // parser function name
    // SPI module fields
    rx_len?: number;
    bit_mask?: number;
    bit_shift?: number;
    scale?: number;
}

export interface ModuleDefinition {
    name: string;
    interface: 'i2c' | 'uart' | 'spi' | 'display' | string;
    i2c?: {
        addr_default: number;
        addr_alt?: number;
    };
    uart?: {
        baud: number;
        bits: number;
        parity: string;
        stop_bits: number;
        line_end?: string;
    };
    spi?: {
        mode: number;
        freq_khz: number;
        cs_active?: string;
        bit_order?: string;
    };
    display?: {
        controller: string;
        width: number;
        height: number;
        addr: number;
        addr_alt?: number;
    };
    init?: Record<number, number>;  // reg → value (I2C init writes)
    fields: Record<string, ModuleFieldDefinition>;
}

export interface ParserEmitterOptions {
    modules?: Record<string, ModuleDefinition>;
    board?: BoardDefinition | undefined;   // lets programs use the board's pin names
}

interface FunctionDefinition {
    addr: number;
    params: string[];
}

export class ParserEmitter {
    private tokens: Token[];
    private current = 0;
    private bytes: number[] = [];
    private availableModules: Record<string, ModuleDefinition>;
    private usedModules = new Map<string, ModuleDefinition>();
    private fieldSlots = new Map<string, number>();
    private variables = new Map<string, number>();
    private variableKinds = new Map<string, VariableKind>();
    private functions = new Map<string, FunctionDefinition>();
    private nextSlot = 0;
    private i2cConfigured = false;
    private uartConfigured = false;
    private spiCsPin: number | null = null;
    private spiPins: { mosi: number; miso: number; sck: number; cs: number } | null = null;
    private initializedModules = new Set<string>();

    private board: BoardDefinition | undefined;

    constructor(tokens: Token[], options: ParserEmitterOptions = {}) {
        this.tokens = tokens;
        this.availableModules = options.modules ?? {};
        this.board = options.board;
    }

    public compile(): Uint8Array {
        while (!this.isAtEnd()) {
            this.parseStatement();
        }
        this.emitByte(OP.HALT);
        return new Uint8Array(this.bytes);
    }

    // Statements

    private parseStatement() {
        if (this.match(TokenType.NEWLINE, TokenType.INDENT, TokenType.DEDENT)) return;

        if (this.match(TokenType.CONFIG))  return this.parseConfigBlock();
        if (this.match(TokenType.USE))     return this.parseUseStatement();
        if (this.match(TokenType.NUM) || this.match(TokenType.TEXT) || this.match(TokenType.BOOL)) {
            return this.parseDeclaration();
        }
        // whole n = 0 / decimal ratio = 1 / bytes reply = [0, 0]
        if (this.check(TokenType.IDENTIFIER) && DECLARATION_WORDS.has(this.peek().value) &&
            this.tokens[this.current + 2]?.type === TokenType.ASSIGN) {
            const word = this.advance().value;
            return this.parseDeclaration(word === 'bytes' ? undefined : word as VariableKind);
        }
        if (this.check(TokenType.LIST) || this.check(TokenType.CLASS)) {
            throw new Error(`'${this.peek().value}' is not supported yet at line ${this.peek().line}`);
        }
        if (this.match(TokenType.FUNC))    return this.parseFunction();
        if (this.match(TokenType.IF))      return this.parseIf();
        if (this.match(TokenType.SET))     return this.parseSetStatement();
        if (this.match(TokenType.READ))    return this.parseReadStatement();
        if (this.match(TokenType.SLEEP))   return this.parseSleep();
        if (this.match(TokenType.REPEAT))  return this.parseRepeat();
        if (this.match(TokenType.GET))     return this.parseGetData();
        if (this.match(TokenType.PRINT))   return this.parsePrint();
        if (this.match(TokenType.CLEAR))   return this.parseClear();
        if (this.match(TokenType.SHOW))    return this.parseShow();
        if (this.match(TokenType.PULSE))   return this.parsePulse();
        if (this.match(TokenType.MOVE))    return this.parseMove();

        if (this.check(TokenType.IDENTIFIER)) {
            const name = this.peek().value;
            if (name === 'type' || name === 'press' || name === 'click' || name === 'scroll') {
                this.advance();
                return this.parseHidStatement(name);
            }
            if (name === 'connect') {
                this.advance();
                return this.parseConnect();
            }
            if (name === 'start' && this.peekNext()?.value === 'wifi') {
                this.advance();
                return this.parseStartWifi();
            }
            if (name === 'serve' && this.peekNext()?.value === 'web') {
                this.advance();
                this.advance();
                this.emitByte(OP.WEB_SERVE);
                this.emitByte(OP.POP);
                return;
            }
            if (name === 'send' && !this.variables.has(name)) {
                this.advance();
                return this.parseSend();
            }
            if (name === 'display' && this.peekNext()?.type === TokenType.ON) {
                this.advance();
                return this.parseDisplay();
            }
            if (name === 'http') {
                const line = this.advance().line;
                this.emitHttpRequest(line);
                this.emitByte(OP.POP);   // fire and forget
                return;
            }
            if (name === 'advertise') {
                const line = this.advance().line;
                const bleName = this.consume(TokenType.STRING, "Expected a name to advertise");
                this.emitByte(OP.BLE_ADVERTISE);
                this.emitInlineString(bleName.value, 26, line);
                this.emitByte(OP.POP);
                return;
            }
            if (name === 'notify') {
                this.advance();
                this.parseExpression();          // any value, sent as text
                this.emitByte(OP.BLE_NOTIFY);
                this.emitByte(OP.POP);
                return;
            }
            if (this.functions.has(name)) {
                this.advance();
                return this.parseCall(name);
            }
            if (this.variables.has(name) && this.peekNext()?.type === TokenType.ASSIGN) {
                return this.parseAssignment();
            }
        }

        throw new Error(`Unsupported statement '${this.peek().value}' at line ${this.peek().line}`);
    }

    private parseConfigBlock() {
        this.consume(TokenType.COLON, "Expected ':' after config");
        this.consume(TokenType.NEWLINE, "Expected newline after config block");
        this.consume(TokenType.INDENT, "Expected indent for config block");

        while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) {
            if (this.check(TokenType.IDENTIFIER)) {
                const section = this.peek().value;
                if (section === 'i2c')  { this.advance(); this.parseI2cConfig();  continue; }
                if (section === 'uart') { this.advance(); this.parseUartConfig(); continue; }
                if (section === 'spi')  { this.advance(); this.parseSpiConfig();  continue; }
            }
            this.skipLine();   // clock/target and anything else the VM ignores
        }

        this.consume(TokenType.DEDENT, "Expected dedent after config block");
    }

    private parseI2cConfig() {
        const sda = this.parseNamedNumber('sda');
        const scl = this.parseNamedNumber('scl');
        this.emitI2cInit(sda, scl);
        this.consumeOptionalNewline();
    }

    private emitI2cInit(sda: number, scl: number) {
        this.emitByte(OP.I2C_INIT);
        this.emitByte(sda);
        this.emitByte(scl);
        this.emitU32(100000);
        this.i2cConfigured = true;
    }

    // No `config: i2c` line? Use the selected board's own SDA/SCL pins, so the
    // same program works on a Pico (GP4/5) and a XIAO (GP6/7) without edits.
    private ensureI2c(module: ModuleDefinition, at: Token) {
        if (this.i2cConfigured) return;
        if (this.board?.pins.SDA === undefined || this.board.pins.SCL === undefined) {
            throw new Error(`'${module.name}' needs to know its I2C pins: pick your board, or add\n` +
                `config:\n    i2c sda=<pin> scl=<pin>\n(line ${at.line})`);
        }
        this.ensureI2cBus(at);
    }

    private parseUartConfig() {
        const tx = this.parseNamedNumber('tx');
        const rx = this.parseNamedNumber('rx');
        let baud = 9600;
        if (this.check(TokenType.IDENTIFIER) && this.peek().value === 'baud') {
            baud = this.parseNamedNumber('baud');
        }

        this.emitByte(OP.UART_INIT);
        this.emitByte(tx);
        this.emitByte(rx);
        this.emitU32(baud);
        this.emitByte(8);   // data bits
        this.emitByte(0);   // parity: none
        this.emitByte(1);   // stop bits
        this.uartConfigured = true;
        this.consumeOptionalNewline();
    }

    private parseSpiConfig() {
        const mosi = this.parseNamedNumber('mosi');
        const miso = this.parseNamedNumber('miso');
        const sck  = this.parseNamedNumber('sck');
        // cs is optional: it's the chip select modules use; programs name one per call.
        const hasCs = this.check(TokenType.IDENTIFIER) && this.peek().value === 'cs';
        const cs = hasCs ? this.parseNamedNumber('cs') : NO_CS;

        this.emitSpiInit(mosi, miso, sck, cs, 1000000, 0);
        if (hasCs) this.spiCsPin = cs;
        this.spiPins = { mosi, miso, sck, cs };
        this.consumeOptionalNewline();
    }

    private emitSpiInit(mosi: number, miso: number, sck: number, cs: number,
                        freqHz: number, mode: number) {
        this.emitByte(OP.SPI_INIT);
        this.emitByte(mosi);
        this.emitByte(miso);
        this.emitByte(sck);
        this.emitByte(cs);
        this.emitU32(freqHz);
        this.emitByte(mode);
    }

    // connect wifi to "SSID" [with "PSK"]  — no password for an open network.
    private parseConnect() {
        const what = this.consumeName("Expected 'wifi' after 'connect'");
        if (what.value !== 'wifi') {
            throw new Error(`Only 'connect wifi' is supported at line ${what.line}`);
        }
        this.consume(TokenType.TO, `Say which network: connect wifi to "name" with "password" (line ${what.line})`);
        this.emitByte(OP.WIFI_CONNECT);
        this.emitWifiCredentials(what.line, 'connect wifi to');
    }

    // start wifi "SSID" [with "PSK"]  — the board becomes the access point.
    private parseStartWifi() {
        const line = this.advance().line;
        this.emitByte(OP.WIFI_AP);
        this.emitWifiCredentials(line, 'start wifi');
    }

    private emitWifiCredentials(line: number, form: string) {
        const ssid = this.consume(TokenType.STRING, `Expected the network name in quotes after '${form}' at line ${line}`).value;
        let password = '';
        if (this.check(TokenType.IDENTIFIER) && this.peek().value === 'with') {
            this.advance();
            password = this.consume(TokenType.STRING, `Expected the password in quotes after 'with' at line ${line}`).value;
        }
        if (password && (password.length < 8 || password.length > 63)) {
            throw new Error(`A Wi-Fi password is 8-63 characters at line ${line}`);
        }
        this.emitInlineString(ssid, 32, line);
        this.emitInlineString(password, 64, line);
        this.emitByte(OP.POP);       // statement form discards the result
    }

    // http get "url" / http post "url" "body" — an expression that yields text.
    private emitHttpRequest(line: number) {
        if (this.match(TokenType.GET)) {
            const url = this.consume(TokenType.STRING, "Expected a url after 'http get'");
            this.emitByte(OP.HTTP_GET);
            this.emitInlineString(url.value, 127, line);
            return;
        }
        const verb = this.consumeName("Expected 'get' or 'post' after 'http'");
        if (verb.value !== 'post') {
            throw new Error(`Expected 'get' or 'post' after 'http' at line ${verb.line}`);
        }
        const url = this.consume(TokenType.STRING, "Expected a url after 'http post'");
        const body = this.consume(TokenType.STRING, "Expected a body after the url");
        this.emitByte(OP.HTTP_POST);
        this.emitInlineString(url.value, 127, line);
        this.emitInlineString(body.value, 127, line);
    }

    private emitInlineString(value: string, max: number, line: number) {
        const encoded = new TextEncoder().encode(value);
        if (encoded.length > max) {
            throw new Error(`Value is too long (max ${max} bytes) at line ${line}`);
        }
        this.emitByte(encoded.length);
        for (const b of encoded) this.emitByte(b);
    }

    private parseUseStatement() {
        const moduleName = this.consume(TokenType.IDENTIFIER, "Expected module name");
        const module = this.availableModules[moduleName.value];
        if (!module) {
            throw new Error(`Module '${moduleName.value}' not found at line ${moduleName.line}`);
        }

        this.usedModules.set(moduleName.value, module);

        if (module.interface === 'display') {
            // Display modules: emit init immediately (runs once, before loops)
            if (!module.display) {
                throw new Error(`Module '${module.name}' is missing display configuration`);
            }
            this.ensureI2c(module, moduleName);
            this.emitByte(OP.DISPLAY_INIT);
            this.emitByte(module.display.addr);
            this.emitByte(module.display.addr_alt ?? 0);   // tried if addr doesn't answer
            this.emitByte(module.display.width);
            this.emitByte(module.display.height);
            const controllerId = DISPLAY_CONTROLLERS[module.display.controller];
            if (controllerId === undefined) {
                throw new Error(`Unknown display controller '${module.display.controller}' in module '${module.name}'`);
            }
            this.emitByte(controllerId);
        } else {
            // Sensor/input modules: allocate one variable slot per field
            for (const fieldName of Object.keys(module.fields)) {
                const key = this.fieldKey(module.name, fieldName);
                if (!this.fieldSlots.has(key)) {
                    this.fieldSlots.set(key, this.allocSlot());
                }
            }
            // Set the bus up here, once, rather than at a `get data` in a loop.
            if (module.interface === 'i2c') this.ensureI2c(module, moduleName);
        }
    }

    // num x = 5 / text s = "hi" / bool b = true / whole n = 0 / decimal r = 1
    private parseDeclaration(kind?: VariableKind) {
        const nameToken = this.consumeName("Expected variable name");
        if (this.variables.has(nameToken.value)) {
            throw new Error(`Variable '${nameToken.value}' is already declared at line ${nameToken.line}`);
        }
        this.consume(TokenType.ASSIGN, "Expected '=' in declaration");
        this.parseExpression();
        if (kind) this.variableKinds.set(nameToken.value, kind);
        else this.variableKinds.delete(nameToken.value);   // a parameter of the same name may have had one

        const slot = this.allocSlot();
        this.variables.set(nameToken.value, slot);
        this.emitStore(nameToken.value, slot);
    }

    private parseAssignment() {
        const nameToken = this.advance();
        this.consume(TokenType.ASSIGN, "Expected '='");
        this.parseExpression();
        this.emitStore(nameToken.value, this.variableSlot(nameToken));
    }

    // Store the value on the stack, converting it for `whole`/`decimal` variables.
    private emitStore(name: string, slot: number) {
        const kind = this.variableKinds.get(name);
        if (kind === 'whole') this.emitByte(OP.TO_WHOLE);
        if (kind === 'decimal') this.emitByte(OP.TO_DECIMAL);
        this.emitByte(OP.STORE);
        this.emitByte(slot);
    }

    // func name p1 p2:
    private parseFunction() {
        const nameToken = this.consumeName("Expected function name");
        if (nameToken.type !== TokenType.IDENTIFIER) {
            throw new Error(`'${nameToken.value}' is a reserved word and can't be a function name at line ${nameToken.line}`);
        }
        const params: string[] = [];
        while (!this.check(TokenType.COLON) && !this.isAtEnd()) {
            params.push(this.advance().value);
        }

        // Jump over the body so definitions don't run where they're written.
        const skip = this.emitJump(OP.JUMP);
        const addr = this.bytes.length;
        this.functions.set(nameToken.value, { addr, params });

        // Every slot this function allocates (params, locals, loop counters) is
        // saved on entry and restored on exit, so recursive calls don't clobber
        // the caller's values. The count is patched once the body is compiled.
        const firstSlot = this.nextSlot;
        this.emitByte(OP.ENTER);
        this.emitByte(firstSlot);
        const countAt = this.bytes.length;
        this.emitByte(0);
        this.emitByte(params.length);

        // Arguments arrive on the stack in order, so unwind them in reverse.
        const outerVars = new Map(this.variables);
        const outerKinds = new Map(this.variableKinds);
        for (const param of [...params].reverse()) {
            const slot = this.allocSlot();
            this.variables.set(param, slot);
            this.variableKinds.delete(param);
            this.emitByte(OP.STORE);
            this.emitByte(slot);
        }

        this.parseBlock();
        const slotCount = this.nextSlot - firstSlot;
        this.bytes[countAt] = slotCount;
        this.emitByte(OP.LEAVE);
        this.emitByte(firstSlot);
        this.emitByte(slotCount);
        this.emitByte(OP.RETURN);
        this.patchJump(skip);
        this.variables = outerVars;   // parameters and body locals go out of scope
        this.variableKinds = outerKinds;
    }

    // name a b  or  name(a, b)
    private parseCall(name: string) {
        const fn = this.functions.get(name)!;
        if (this.check(TokenType.LPAREN) && fn.params.length !== 1) {
            const at = this.advance().line;
            const count = this.parseArguments();
            if (count !== fn.params.length) {
                throw new Error(`'${name}' takes ${fn.params.length} value${fn.params.length === 1 ? '' : 's'}, got ${count}, at line ${at}`);
            }
        } else {
            for (let i = 0; i < fn.params.length; i++) {
                this.parseExpression();
            }
        }
        this.emitByte(OP.CALL);
        this.emitByte((fn.addr >> 8) & 0xFF);
        this.emitByte(fn.addr & 0xFF);
        this.emitByte(fn.params.length);
    }

    private parseIf() {
        this.parseExpression();
        const toElse = this.emitJump(OP.JUMP_IF_FALSE);
        this.parseBlock();

        this.skipNewlines();
        if (this.match(TokenType.ELSE)) {
            const toEnd = this.emitJump(OP.JUMP);
            this.patchJump(toElse);
            this.parseBlock();
            this.patchJump(toEnd);
        } else {
            this.patchJump(toElse);
        }
    }

    // set pin N high|low   |   set pixel/pixels/brightness ... (NeoPixel)
    private parseSetStatement() {
        // set x to 5  |  set reply[1] to 0xFF
        if (this.check(TokenType.IDENTIFIER) && this.variables.has(this.peek().value)) {
            const nameToken = this.advance();
            const slot = this.variableSlot(nameToken);
            if (this.match(TokenType.LBRACKET)) {
                this.emitByte(OP.LOAD);
                this.emitByte(slot);
                this.parseExpression();
                this.consume(TokenType.RBRACKET, "Expected ']'");
                this.consume(TokenType.TO, `Expected 'to': set ${nameToken.value}[i] to <value>`);
                this.parseExpression();
                this.emitByte(OP.SET_INDEX);
            } else {
                this.consume(TokenType.TO, `Expected 'to': set ${nameToken.value} to <value>`);
                this.parseExpression();
            }
            this.emitStore(nameToken.value, slot);
            return;
        }
        if (this.check(TokenType.IDENTIFIER)) {
            const what = this.peek().value;
            if (what === 'pixel' || what === 'pixels' || what === 'brightness') {
                this.advance();
                return this.parsePixelStatement(what);
            }
        }

        this.consume(TokenType.PIN, "Expected 'pin'");
        const { pin, indicator } = this.parsePin();
        let state = 0;
        if (this.match(TokenType.HIGH)) state = 1;
        else if (this.match(TokenType.LOW)) state = 0;
        else throw new Error(`Expected 'high' or 'low' at line ${this.peek().line}`);
        // Named active-low LEDs: `high` means lit, whatever the wiring.
        if (indicator?.activeLow) state ^= 1;

        this.emitByte(OP.GPIO_WRITE);
        this.emitByte(pin);
        this.emitByte(state);
    }

    // set pixel 0 on pin 16 to 255 0 0 | set pixels on pin 16 to 0 0 255
    // set brightness on pin 16 to 128  | show pixels on pin 16
    private parsePixelStatement(what: string) {
        let index = 0;
        if (what === 'pixel') index = this.literalNumber("Expected pixel index");
        this.consume(TokenType.ON, "Expected 'on'");
        this.consume(TokenType.PIN, "Expected 'pin'");
        const pin = this.literalPin();
        this.consume(TokenType.TO, "Expected 'to'");

        if (what === 'brightness') {
            this.emitByte(OP.NEO_BRIGHTNESS);
            this.emitByte(pin);
            this.emitByte(this.literalNumber("Expected brightness 0-255"));
            return;
        }

        const [r, g, b] = this.parseColor();

        if (what === 'pixel') {
            this.emitByte(OP.NEO_SET);
            this.emitByte(pin);
            this.emitByte((index >> 8) & 0xFF);
            this.emitByte(index & 0xFF);
        } else {
            this.emitByte(OP.NEO_SET_ALL);
            this.emitByte(pin);
        }
        this.emitByte(r);
        this.emitByte(g);
        this.emitByte(b);
    }

    // read pin N | read analog pin N [as voltage] — prints the value
    private parseReadStatement() {
        this.emitRead();
        this.emitByte(OP.PRINT);
    }

    // The expression form of a read, leaving the value on the stack.
    private emitRead() {
        // read <n> bytes from i2c <addr> [at <reg>]  |  read <n> bytes from spi with cs <pin>
        if (!this.check(TokenType.ANALOG) && !this.check(TokenType.PIN)) {
            const at = this.peek();
            this.parseOperand();
            const unit = this.consumeName("Expected 'bytes'");
            if (unit.value !== 'bytes' && unit.value !== 'byte') {
                throw new Error(`Expected 'read pin N', 'read analog pin N' or 'read N bytes from i2c|spi ...' at line ${at.line}`);
            }
            this.consume(TokenType.FROM, "Expected 'from'");
            const bus = this.consumeName("Expected 'i2c' or 'spi'");
            if (bus.value === 'i2c') {
                this.ensureI2cBus(bus);
                this.parseOperand();
                const hasReg = this.match(TokenType.AT);
                if (hasReg) this.parseOperand();
                this.emitByte(OP.I2C_RECV);
                this.emitByte(hasReg ? 1 : 0);
                return;
            }
            if (bus.value === 'spi') {
                this.parseChipSelect(bus);
                this.emitByte(OP.SPI_EXCHANGE);
                this.emitByte(1);   // the count is how many zero bytes to clock out
                return;
            }
            throw new Error(`Expected 'i2c' or 'spi' after 'from' at line ${bus.line}`);
        }
        if (this.match(TokenType.ANALOG)) {
            this.consume(TokenType.PIN, "Expected 'pin'");
            const pin = this.parsePinOperand();
            let asVoltage = false;
            if (this.match(TokenType.AS)) {
                this.consume(TokenType.VOLTAGE, "Expected 'voltage' after 'as'");
                asVoltage = true;
            }
            this.emitByte(asVoltage ? OP.ADC_READ_VOLT : OP.ADC_READ_RAW);
            this.emitByte(pin);
            return;
        }

        this.consume(TokenType.PIN, "Expected 'pin'");
        const { pin, indicator } = this.parsePin();
        this.emitByte(OP.GPIO_READ);
        this.emitByte(pin);
        // Named active-low buttons read true while pressed.
        if (indicator?.activeLow) this.emitByte(OP.NOT);
    }

    // send <data> to i2c <addr> [at <reg>]  |  send <data> to spi with cs <pin>
    // Data is bytes ([0x01, 0xFF]), text, or a number (one byte).
    private parseSend() {
        this.parseOperand();
        this.consume(TokenType.TO, "Expected 'to': send <data> to i2c <address> / send <data> to spi with cs <pin>");
        const bus = this.consumeName("Expected 'i2c' or 'spi'");
        if (bus.value === 'i2c') {
            this.ensureI2cBus(bus);
            this.parseOperand();
            const hasReg = this.match(TokenType.AT);
            if (hasReg) this.parseOperand();
            this.emitByte(OP.I2C_SEND);
            this.emitByte(hasReg ? 1 : 0);
            return;
        }
        if (bus.value === 'spi') {
            this.parseChipSelect(bus);
            this.emitByte(OP.SPI_EXCHANGE);
            this.emitByte(0);
            this.emitByte(OP.POP);   // what came back isn't wanted
            return;
        }
        throw new Error(`Expected 'i2c' or 'spi' after 'to' at line ${bus.line}`);
    }

    // `with cs <pin>` — any pin, so several chips share the bus. Sets the bus up first.
    private parseChipSelect(bus: Token) {
        this.ensureSpi(bus);
        const withWord = this.consumeName("Expected 'with cs <pin>'");
        const cs = this.consumeName("Expected 'with cs <pin>'");
        if (withWord.value !== 'with' || cs.value !== 'cs') {
            throw new Error(`Say which chip: ... with cs <pin> at line ${bus.line}`);
        }
        const { pin } = this.parsePin();
        if (pin !== PIN_FROM_STACK) this.emitPushNumber(pin);
    }

    private ensureI2cBus(at: Token) {
        if (this.i2cConfigured) return;
        const sda = this.board?.pins.SDA, scl = this.board?.pins.SCL;
        if (sda === undefined || scl === undefined) {
            throw new Error(`I2C needs to know its pins: pick your board, or add\n` +
                `config:\n    i2c sda=<pin> scl=<pin>\n(line ${at.line})`);
        }
        this.emitI2cInit(sda, scl);
    }

    // The board's SCK/MOSI/MISO unless `config: spi ...` named others.
    private ensureSpi(at: Token) {
        if (this.spiPins) return;
        const pins = this.board?.pins;
        if (pins?.SCK === undefined || pins.MOSI === undefined || pins.MISO === undefined) {
            throw new Error(`SPI needs to know its pins: pick your board, or add\n` +
                `config:\n    spi mosi=<pin> miso=<pin> sck=<pin>\n(line ${at.line})`);
        }
        this.emitSpiInit(pins.MOSI, pins.MISO, pins.SCK, NO_CS, 1000000, 0);
        this.spiPins = { mosi: pins.MOSI, miso: pins.MISO, sck: pins.SCK, cs: NO_CS };
    }

    private parseSleep() {
        const num = this.consume(TokenType.NUMBER, "Expected sleep time");
        if (this.match(TokenType.MS)) {
            this.emitSleepOpcode(OP.SLEEP_MS, parseInt(num.value));
        } else if (this.match(TokenType.S)) {
            this.emitSleepOpcode(OP.SLEEP_MS, parseInt(num.value) * 1000);
        } else if (this.match(TokenType.US)) {
            this.emitSleepOpcode(OP.SLEEP_US, parseInt(num.value));
        } else {
            throw new Error("Expected a sleep unit ('ms', 's', or 'us') at line " + this.peek().line);
        }
    }

    // pulse 255 on pin 10 [at 1000hz]
    private parsePulse() {
        const duty = this.literalNumber("Expected duty 0-255 after 'pulse'");
        this.consume(TokenType.ON, "Expected 'on'");
        this.consume(TokenType.PIN, "Expected 'pin'");
        const pin = this.parsePinOperand();

        let freq = 1000;
        if (this.match(TokenType.AT)) {
            freq = this.literalNumber("Expected frequency");
            this.consume(TokenType.HZ, "Expected 'hz'");
        }

        if (duty === 0) {
            this.emitByte(OP.PWM_OFF);
            this.emitByte(pin);
            return;
        }
        this.emitByte(OP.PWM_SET);
        this.emitByte(pin);
        this.emitByte(duty);
        this.emitByte((freq >> 8) & 0xFF);
        this.emitByte(freq & 0xFF);
    }

    // move servo on pin 12 to 90   |   move mouse 10 -5
    private parseMove() {
        if (this.match(TokenType.SERVO)) {
            this.consume(TokenType.ON, "Expected 'on'");
            this.consume(TokenType.PIN, "Expected 'pin'");
            const pin = this.parsePinOperand();
            this.consume(TokenType.TO, "Expected 'to'");
            const angle = this.signedLiteral("Expected servo angle -90..90");
            this.emitByte(OP.SERVO_SET);
            this.emitByte(pin);
            this.emitByte((angle >> 8) & 0xFF);
            this.emitByte(angle & 0xFF);
            return;
        }

        if (this.check(TokenType.IDENTIFIER) && this.peek().value === 'mouse') {
            this.advance();
            const dx = this.signedLiteral("Expected mouse dx");
            const dy = this.signedLiteral("Expected mouse dy");
            this.emitHidMouse(dx, dy, 0, 0);
            return;
        }

        throw new Error(`Expected 'servo' or 'mouse' after 'move' at line ${this.peek().line}`);
    }

    // type "text" | press "ctrl+c" | click left | scroll -2
    private parseHidStatement(kind: string) {
        if (kind === 'type') {
            const text = this.consume(TokenType.STRING, "Expected a string to type");
            const encoded = new TextEncoder().encode(text.value);
            if (encoded.length > 255) throw new Error(`String too long to type at line ${text.line}`);
            this.emitByte(OP.HID_TYPE);
            this.emitByte(encoded.length);
            for (const b of encoded) this.emitByte(b);
            return;
        }

        if (kind === 'press') {
            const combo = this.consume(TokenType.STRING, "Expected a key combo like \"ctrl+c\"");
            let modifier = 0;
            let keycode = 0;
            for (const part of combo.value.split('+')) {
                const name = part.trim().toLowerCase();
                if (HID_MODIFIERS[name] !== undefined) {
                    modifier |= HID_MODIFIERS[name]!;
                    continue;
                }
                const code = hidKeycode(name);
                if (code === undefined) {
                    throw new Error(`Unknown key '${part}' at line ${combo.line}`);
                }
                keycode = code;
            }
            this.emitByte(OP.HID_KEY);
            this.emitByte(modifier);
            this.emitByte(keycode);
            return;
        }

        if (kind === 'click') {
            const button = this.consumeName("Expected 'left', 'right' or 'middle'");
            const bit = HID_MOUSE_BUTTONS[button.value.toLowerCase()];
            if (bit === undefined) {
                throw new Error(`Unknown mouse button '${button.value}' at line ${button.line}`);
            }
            this.emitHidMouse(0, 0, bit, 0);
            return;
        }

        // scroll N
        this.emitHidMouse(0, 0, 0, this.signedLiteral("Expected scroll amount"));
    }

    private emitHidMouse(dx: number, dy: number, buttons: number, scroll: number) {
        this.emitByte(OP.HID_MOUSE);
        this.emitByte(dx & 0xFF);
        this.emitByte(dy & 0xFF);
        this.emitByte(buttons);
        this.emitByte(scroll & 0xFF);
    }

    private parseRepeat() {
        if (this.match(TokenType.FOREVER)) {
            const loopStart = this.bytes.length;
            this.parseBlock();
            this.emitLoop(loopStart);
            return;
        }

        // `repeat <count>:` counts down in a slot — works for literals and
        // variables alike, and never unrolls the body.
        this.parseExpression();
        const counter = this.allocSlot();
        this.emitByte(OP.STORE);
        this.emitByte(counter);

        const loopStart = this.bytes.length;
        this.emitByte(OP.LOAD);
        this.emitByte(counter);
        this.emitPushNumber(0);
        this.emitByte(OP.GT);
        const exit = this.emitJump(OP.JUMP_IF_FALSE);

        this.parseBlock();

        this.emitByte(OP.LOAD);
        this.emitByte(counter);
        this.emitPushNumber(1);
        this.emitByte(OP.SUB);
        this.emitByte(OP.STORE);
        this.emitByte(counter);
        this.emitLoop(loopStart);
        this.patchJump(exit);
    }

    private parseGetData() {
        this.consume(TokenType.DATA, "Expected 'data'");
        this.consume(TokenType.FROM, "Expected 'from'");
        const moduleName = this.consume(TokenType.IDENTIFIER, "Expected module name");
        const module = this.usedModules.get(moduleName.value);
        if (!module) {
            throw new Error(`Module '${moduleName.value}' was not imported with 'use' at line ${moduleName.line}`);
        }

        if (module.interface === 'i2c')       this.emitI2cGetData(module, moduleName);
        else if (module.interface === 'uart') this.emitUartGetData(module, moduleName);
        else if (module.interface === 'spi')  this.emitSpiGetData(module, moduleName);
        else {
            throw new Error(`Module '${module.name}' uses unsupported interface '${module.interface}' at line ${moduleName.line}`);
        }
    }

    private emitI2cGetData(module: ModuleDefinition, moduleName: Token) {
        if (!module.i2c) {
            throw new Error(`Module '${module.name}' is missing i2c metadata`);
        }
        this.ensureI2c(module, moduleName);

        // Emit init register writes on first use of this module
        if (!this.initializedModules.has(module.name) && module.init) {
            for (const [regStr, val] of Object.entries(module.init)) {
                const reg = Number(regStr);
                this.emitByte(OP.I2C_WRITE);
                this.emitByte(module.i2c.addr_default);
                this.emitByte(reg);
                this.emitByte(1);   // write 1 byte
                this.emitByte(val);
            }
            this.initializedModules.add(module.name);
        }

        for (const [fieldName, field] of Object.entries(module.fields)) {
            const transformId = TRANSFORM_IDS[field.transform];
            if (transformId === undefined) {
                throw new Error(`Unsupported transform '${field.transform}' for ${module.name}.${fieldName}`);
            }

            this.emitByte(OP.I2C_READ);
            this.emitByte(module.i2c.addr_default);
            this.emitByte(field.reg);
            this.emitByte(field.len);
            this.emitByte(OP.TRANSFORM);
            this.emitByte(transformId);
            this.emitByte(OP.STORE);
            this.emitByte(this.getFieldSlot(module.name, fieldName));
        }
    }

    private emitUartGetData(module: ModuleDefinition, moduleName: Token) {
        if (!this.uartConfigured) {
            throw new Error(`Module '${module.name}' requires a uart config block before use at line ${moduleName.line}`);
        }

        for (const [fieldName, field] of Object.entries(module.fields)) {
            // Read a line from UART (2-second timeout)
            this.emitByte(OP.UART_READ_LINE);
            this.emitU32(2000);

            // Apply protocol parser if defined
            if (field.parse) {
                const parserId = PARSER_IDS[field.parse];
                if (parserId === undefined) {
                    throw new Error(`Unsupported parser '${field.parse}' for ${module.name}.${fieldName}`);
                }
                this.emitByte(OP.UART_APPLY_PARSER);
                this.emitByte(parserId);
            }

            this.emitByte(OP.STORE);
            this.emitByte(this.getFieldSlot(module.name, fieldName));
        }
    }

    private emitSpiGetData(module: ModuleDefinition, moduleName: Token) {
        if (this.spiCsPin === null || !this.spiPins) {
            throw new Error(`Module '${module.name}' requires an spi config block before use at line ${moduleName.line}`);
        }

        // Re-init the bus with the module's own speed and mode on first use.
        if (!this.initializedModules.has(module.name) && module.spi) {
            const { mosi, miso, sck, cs } = this.spiPins;
            this.emitSpiInit(mosi, miso, sck, cs,
                             (module.spi.freq_khz || 1000) * 1000, module.spi.mode || 0);
            this.initializedModules.add(module.name);
        }

        for (const [fieldName, field] of Object.entries(module.fields)) {
            const rxLen = field.rx_len ?? field.len ?? 0;
            if (!rxLen) {
                throw new Error(`Field ${module.name}.${fieldName} is missing rx_len`);
            }

            this.emitByte(OP.SPI_TRANSFER);
            this.emitByte(this.spiCsPin);
            this.emitByte(0);        // nothing to send — read-only device
            this.emitByte(rxLen);

            // twos_complement_<bits> tells the VM how wide the signed field is.
            const signBits = field.transform?.startsWith('twos_complement_')
                ? parseInt(field.transform.slice('twos_complement_'.length), 10) || 0
                : 0;

            this.emitByte(OP.SPI_READ_FIELD);
            this.emitU32(field.bit_mask ?? 0xFFFFFFFF);
            this.emitByte(field.bit_shift ?? 0);
            this.emitByte(signBits);
            this.emitF32(field.scale ?? 1);
            this.emitByte(OP.STORE);
            this.emitByte(this.getFieldSlot(module.name, fieldName));
        }
    }

    // print "literal" | print <expression>
    private parsePrint() {
        if (this.check(TokenType.STRING) && !this.isExpressionContinuation(1)) {
            const strToken = this.advance();
            this.emitByte(OP.PRINT_STR);
            const encoded = new TextEncoder().encode(strToken.value);
            if (encoded.length > 255) {
                throw new Error(`String too long for print at line ${strToken.line}`);
            }
            this.emitByte(encoded.length);
            for (const b of encoded) this.emitByte(b);
            return;
        }

        this.parseExpression();
        this.emitByte(OP.PRINT);
    }

    private parseClear() {
        const moduleName = this.consume(TokenType.IDENTIFIER, "Expected module name after 'clear'");
        const module = this.usedModules.get(moduleName.value);
        if (!module) {
            throw new Error(`Module '${moduleName.value}' was not imported with 'use' at line ${moduleName.line}`);
        }
        if (module.interface !== 'display') {
            throw new Error(`Module '${module.name}' is not a display module at line ${moduleName.line}`);
        }
        this.emitByte(OP.DISPLAY_CLEAR);
    }

    // display on <display> <expr> [at X Y] [size N]
    // Without `at`, each display goes on the next line down (scrolling when
    // full), like print; `clear` starts again at the top.
    private parseDisplay() {
        this.consume(TokenType.ON, "Expected 'on'");
        const nameToken = this.consume(TokenType.IDENTIFIER, "Expected display module name");
        const module = this.usedModules.get(nameToken.value);
        if (!module || module.interface !== 'display') {
            throw new Error(`'${nameToken.value}' is not a display module at line ${nameToken.line} — add 'use ${nameToken.value}'`);
        }
        this.parseExpression();

        const width = module.display?.width ?? 128;
        const height = module.display?.height ?? 64;
        let x = 0, y = 0, size = 1, flags = DISPLAY_AT_CURSOR;
        if (this.match(TokenType.AT)) {
            x = this.literalNumber("Expected x position");
            y = this.literalNumber("Expected y position");
            if (x >= width || y >= height) {
                throw new Error(`Position ${x} ${y} is off the ${width}x${height} display at line ${nameToken.line}`);
            }
            flags = 0;
        }
        if (this.check(TokenType.IDENTIFIER) && this.peek().value === 'size') {
            this.advance();
            size = this.literalNumber("Expected text size 1-4");
            if (size < 1 || size > 4) throw new Error(`Text size must be 1-4 at line ${nameToken.line}`);
        }

        this.emitByte(OP.DISPLAY_DRAW);
        this.emitByte(x);
        this.emitByte(y);
        this.emitByte(size);
        this.emitByte(flags);
    }

    // show "text" on <display> [line N] | show <expr> on <display> [line N]
    // show pixels on pin N
    private parseShow() {
        if (!(this.check(TokenType.IDENTIFIER) && this.peek().value === 'pixels')) {
            throw new Error(`Use 'display on <screen> "text"' to draw on a screen, or 'show pixels on pin N' for NeoPixels, at line ${this.peek().line}`);
        }
        this.advance();
        this.consume(TokenType.ON, "Expected 'on'");
        this.consume(TokenType.PIN, "Expected 'pin'");
        const pin = this.literalPin();
        this.emitByte(OP.NEO_SHOW);
        this.emitByte(pin);
    }

    // Expressions

    // An expression, optionally read as a fixed-width number:
    //   raw as signed 16-bit  |  reply as unsigned 24-bit little endian
    private parseExpression() {
        this.parseOr();
        if (this.check(TokenType.AS) && ['signed', 'unsigned'].includes(this.peekNext()?.value ?? '')) {
            const as = this.advance();
            const signed = this.advance().value === 'signed';
            const bits = this.literalNumber("Expected a bit width: 8, 16, 24 or 32");
            const bit = this.consume(TokenType.MINUS, "Expected '-bit', like 16-bit") && this.consumeName("Expected '-bit'");
            if (bit.value !== 'bit' || ![8, 16, 24, 32].includes(bits)) {
                throw new Error(`Expected 8-bit, 16-bit, 24-bit or 32-bit at line ${as.line}`);
            }
            let little = false;
            if (this.check(TokenType.IDENTIFIER) && ['big', 'little'].includes(this.peek().value)) {
                little = this.advance().value === 'little';
                const endian = this.consumeName("Expected 'endian'");
                if (endian.value !== 'endian') throw new Error(`Expected 'big endian' or 'little endian' at line ${as.line}`);
            }
            this.emitByte(OP.DECODE);
            this.emitByte((signed ? 1 : 0) | (little ? 2 : 0));
            this.emitByte(bits);
        }
    }

    // An operand inside a statement (an address, a register, data to send):
    // everything but a trailing `as ...`, which belongs to the whole statement.
    private parseOperand() { this.parseOr(); }

    // (a, b, c) after the '(' — returns how many values were pushed.
    private parseArguments(): number {
        let count = 0;
        if (!this.check(TokenType.RPAREN)) {
            do { this.parseExpression(); count++; } while (this.match(TokenType.COMMA));
        }
        this.consume(TokenType.RPAREN, "Expected ')'");
        return count;
    }

    private parseOr() {
        this.parseAnd();
        while (this.match(TokenType.OR)) {
            this.parseAnd();
            this.emitByte(OP.OR);
        }
    }

    private parseAnd() {
        this.parseEquality();
        while (this.match(TokenType.AND)) {
            this.parseEquality();
            this.emitByte(OP.AND);
        }
    }

    private parseEquality() {
        this.parseComparison();
        for (;;) {
            if (this.match(TokenType.EQ))       { this.parseComparison(); this.emitByte(OP.EQ); }
            else if (this.match(TokenType.NEQ)) { this.parseComparison(); this.emitByte(OP.NEQ); }
            else return;
        }
    }

    private parseComparison() {
        this.parseBitOr();
        for (;;) {
            if (this.match(TokenType.GT))       { this.parseBitOr(); this.emitByte(OP.GT); }
            else if (this.match(TokenType.LT))  { this.parseBitOr(); this.emitByte(OP.LT); }
            else if (this.match(TokenType.GTE)) { this.parseBitOr(); this.emitByte(OP.GTE); }
            else if (this.match(TokenType.LTE)) { this.parseBitOr(); this.emitByte(OP.LTE); }
            else return;
        }
    }

    // Bit operators, loosest to tightest: | ^ & then << >> (Python's order).
    private parseBitOr() {
        this.parseBitXor();
        while (this.match(TokenType.BOR)) { this.parseBitXor(); this.emitByte(OP.BOR); }
    }

    private parseBitXor() {
        this.parseBitAnd();
        while (this.match(TokenType.BXOR)) { this.parseBitAnd(); this.emitByte(OP.BXOR); }
    }

    private parseBitAnd() {
        this.parseShift();
        while (this.match(TokenType.BAND)) { this.parseShift(); this.emitByte(OP.BAND); }
    }

    private parseShift() {
        this.parseTerm();
        for (;;) {
            if (this.match(TokenType.SHL))      { this.parseTerm(); this.emitByte(OP.SHL); }
            else if (this.match(TokenType.SHR)) { this.parseTerm(); this.emitByte(OP.SHR); }
            else return;
        }
    }

    private parseTerm() {
        this.parseFactor();
        for (;;) {
            if (this.match(TokenType.PLUS))       { this.parseFactor(); this.emitByte(OP.ADD); }
            else if (this.match(TokenType.MINUS)) { this.parseFactor(); this.emitByte(OP.SUB); }
            else return;
        }
    }

    private parseFactor() {
        this.parseUnary();
        for (;;) {
            if (this.match(TokenType.MULTIPLY))    { this.parseUnary(); this.emitByte(OP.MUL); }
            else if (this.match(TokenType.DIVIDE)) { this.parseUnary(); this.emitByte(OP.DIV); }
            else if (this.match(TokenType.IDIV))   { this.parseUnary(); this.emitByte(OP.IDIV); }
            else if (this.match(TokenType.MODULO)) { this.parseUnary(); this.emitByte(OP.MOD); }
            else return;
        }
    }

    private parseUnary() {
        if (this.match(TokenType.NOT)) {
            this.parseUnary();
            this.emitByte(OP.NOT);
            return;
        }
        if (this.match(TokenType.MINUS)) {
            // -2 is a literal, but -2 ** 2 is -(2 ** 2), like Python.
            if (this.check(TokenType.NUMBER) && this.peekNext()?.type !== TokenType.POWER) {
                this.emitPushNumber(-parseFloat(this.advance().value));
                return;
            }
            this.emitPushNumber(0);
            this.parseUnary();
            this.emitByte(OP.SUB);   // 0 - x
            return;
        }
        if (this.match(TokenType.BNOT)) {
            this.parseUnary();
            this.emitByte(OP.BNOT);
            return;
        }
        this.parsePower();
    }

    // x ** y binds tighter than a minus sign and groups right to left.
    private parsePower() {
        this.parsePostfix();
        if (this.match(TokenType.POWER)) {
            this.parseUnary();
            this.emitByte(OP.POW);
        }
    }

    // reply[0], name[-1]
    private parsePostfix() {
        this.parsePrimary();
        while (this.match(TokenType.LBRACKET)) {
            this.parseExpression();
            this.consume(TokenType.RBRACKET, "Expected ']'");
            this.emitByte(OP.INDEX);
        }
    }

    private parsePrimary() {
        if (this.check(TokenType.NUMBER)) {
            this.emitPushNumber(parseFloat(this.advance().value));
            return;
        }
        if (this.check(TokenType.STRING)) {
            const str = this.advance();
            const encoded = new TextEncoder().encode(str.value);
            if (encoded.length > 63) {
                throw new Error(`String literal too long (max 63 bytes) at line ${str.line}`);
            }
            this.emitByte(OP.PUSH_STR);
            this.emitByte(encoded.length);
            for (const b of encoded) this.emitByte(b);
            return;
        }
        if (this.match(TokenType.TRUE))  { this.emitByte(OP.PUSH_BOOL); this.emitByte(1); return; }
        if (this.match(TokenType.FALSE)) { this.emitByte(OP.PUSH_BOOL); this.emitByte(0); return; }
        if (this.match(TokenType.LPAREN)) {
            this.parseExpression();
            this.consume(TokenType.RPAREN, "Expected ')'");
            return;
        }
        if (this.match(TokenType.READ)) {
            this.emitRead();
            return;
        }
        // [0x9F, 0, 0] — bytes
        if (this.check(TokenType.LBRACKET)) {
            const at = this.advance().line;
            let count = 0;
            if (!this.check(TokenType.RBRACKET)) {
                do { this.parseExpression(); count++; } while (this.match(TokenType.COMMA));
            }
            this.consume(TokenType.RBRACKET, "Expected ']'");
            if (count > 64) throw new Error(`At most 64 bytes in [ ] at line ${at}`);
            this.emitByte(OP.MAKE_BYTES);
            this.emitByte(count);
            return;
        }

        if (this.check(TokenType.IDENTIFIER) && !this.variables.has(this.peek().value) && !this.functions.has(this.peek().value)) {
            const word = this.peek().value;
            // bit 7 of status -> true/false
            if (word === 'bit') {
                this.advance();
                this.parseTerm();
                this.consumeWord('of', "Expected 'of': bit N of <value>");
                this.parseUnary();
                this.emitByte(OP.GET_BIT);
                return;
            }
            // length of reply
            if (word === 'length' && this.peekNext()?.value === 'of') {
                this.advance();
                this.advance();
                this.parseUnary();
                this.emitByte(OP.LENGTH);
                return;
            }
            // spi transfer <data> with cs <pin> -> the bytes that came back
            if (word === 'spi' && this.peekNext()?.value === 'transfer') {
                const spi = this.advance();
                this.advance();
                this.parseOperand();
                this.parseChipSelect(spi);
                this.emitByte(OP.SPI_EXCHANGE);
                this.emitByte(0);
                return;
            }
            // abs(x), round temp, min(a, b), random(1, 6) ...
            const fn = MATH_FUNCTIONS[word];
            if (fn) {
                const at = this.advance().line;
                if (this.match(TokenType.LPAREN)) {
                    const count = this.parseArguments();
                    if (count !== fn.argc) {
                        throw new Error(`${word}() takes ${fn.argc} value${fn.argc === 1 ? '' : 's'}, got ${count}, at line ${at}`);
                    }
                } else if (fn.argc === 1) {
                    this.parseUnary();
                } else {
                    throw new Error(`${word} takes ${fn.argc} values — write it with brackets, like ${word}(${['a', 'b', 'c', 'd', 'e'].slice(0, fn.argc).join(', ')}), at line ${at}`);
                }
                this.emitByte(OP.MATH);
                this.emitByte(fn.id);
                return;
            }
        }

        // wifi connected | wifi ip | http get "url"
        if (this.check(TokenType.IDENTIFIER) && this.peek().value === 'wifi') {
            const wifi = this.advance();
            const what = this.consumeName("Expected 'connected' or 'ip' after 'wifi'");
            if (what.value === 'connected') { this.emitByte(OP.WIFI_STATUS); return; }
            if (what.value === 'ip')        { this.emitByte(OP.WIFI_IP);     return; }
            throw new Error(`Expected 'connected' or 'ip' after 'wifi' at line ${wifi.line}`);
        }
        if (this.check(TokenType.IDENTIFIER) && this.peek().value === 'http') {
            this.emitHttpRequest(this.advance().line);
            return;
        }
        // ble connected | ble message
        if (this.check(TokenType.IDENTIFIER) && this.peek().value === 'ble') {
            const ble = this.advance();
            const what = this.consumeName("Expected 'connected' or 'message' after 'ble'");
            if (what.value === 'connected') { this.emitByte(OP.BLE_STATUS);  return; }
            if (what.value === 'message')   { this.emitByte(OP.BLE_MESSAGE); return; }
            throw new Error(`Expected 'connected' or 'message' after 'ble' at line ${ble.line}`);
        }

        // module.field, or a variable / parameter
        const token = this.advance();
        if (this.check(TokenType.DOT)) {
            this.advance();
            const fieldToken = this.consumeName("Expected field name");
            const module = this.usedModules.get(token.value);
            if (!module) {
                throw new Error(`Module '${token.value}' was not imported with 'use' at line ${token.line}`);
            }
            if (!module.fields[fieldToken.value]) {
                throw new Error(`Module '${module.name}' has no field '${fieldToken.value}' at line ${fieldToken.line}`);
            }
            this.emitByte(OP.LOAD);
            this.emitByte(this.getFieldSlot(module.name, fieldToken.value));
            return;
        }

        this.emitByte(OP.LOAD);
        this.emitByte(this.variableSlot(token));
    }

    // Helpers

    private parseBlock() {
        this.consume(TokenType.COLON, "Expected ':'");
        this.consume(TokenType.NEWLINE, "Expected newline after ':'");
        this.consume(TokenType.INDENT, "Expected an indented block");
        while (!this.check(TokenType.DEDENT) && !this.isAtEnd()) {
            this.parseStatement();
        }
        this.consume(TokenType.DEDENT, "Expected dedent");
    }

    // A pin is a literal, a board pin name (LED, NEOPIXEL, A0...), or anything
    // else computed onto the stack. Must run before the opcode is emitted: a
    // named indicator with a power pin emits its power-on write here.
    private parsePin(): { pin: number; indicator?: Indicator | undefined } {
        if (this.check(TokenType.NUMBER)) {
            return { pin: parseInt(this.advance().value) };
        }
        const token = this.peek();
        if (token.type === TokenType.IDENTIFIER && !this.variables.has(token.value)) {
            const pin = this.board?.pins[token.value];
            if (pin !== undefined) {
                this.advance();
                const indicator = this.board!.indicators[token.value];
                if (indicator?.power !== undefined) {
                    this.emitByte(OP.GPIO_WRITE);   // e.g. QT Py: NeoPixel needs GP11 high
                    this.emitByte(indicator.power);
                    this.emitByte(1);
                }
                return { pin, indicator };
            }
            if (/^[A-Z][A-Z0-9_]*$/.test(token.value)) {
                throw new Error(`Unknown pin '${token.value}' at line ${token.line}` +
                    (this.board ? ` — ${this.board.title} has no pin by that name`
                                : ' — select a board so pin names like LED resolve'));
            }
        }
        this.parseExpression();
        return { pin: PIN_FROM_STACK };
    }

    private parsePinOperand(): number {
        return this.parsePin().pin;
    }

    // A colour: `r g b` (0-255 each) or a name like red / orange / off.
    private parseColor(): [number, number, number] {
        const token = this.peek();
        if (token.type !== TokenType.NUMBER) {
            const named = COLORS[token.value];
            if (!named) {
                throw new Error(`Expected a colour (r g b, or one of ${Object.keys(COLORS).join(', ')}) at line ${token.line}`);
            }
            this.advance();
            return named;
        }
        const r = this.literalNumber("Expected red value");
        const g = this.literalNumber("Expected green value");
        const b = this.literalNumber("Expected blue value");
        return [r, g, b];
    }

    // NeoPixel opcodes take a fixed pin: a number or a board pin name.
    private literalPin(): number {
        const { pin } = this.parsePin();
        if (pin === PIN_FROM_STACK) throw new Error(`Expected a pin number or name at line ${this.peek().line}`);
        return pin;
    }

    // `sda=20` style config values.
    private parseNamedNumber(name: string): number {
        const key = this.consume(TokenType.IDENTIFIER, `Expected '${name}'`);
        if (key.value !== name) {
            throw new Error(`Expected '${name}' at line ${key.line}`);
        }
        this.consume(TokenType.ASSIGN, "Expected '='");
        // A board pin name works too: sda=SDA, tx=TX, cs=D10.
        const named = this.check(TokenType.IDENTIFIER) ? this.board?.pins[this.peek().value] : undefined;
        if (named !== undefined) {
            this.advance();
            return named;
        }
        const value = this.consume(TokenType.NUMBER, `Expected a pin number${this.board ? ' or name' : ''} for ${name}`);
        return parseInt(value.value);
    }

    private literalNumber(message: string): number {
        const token = this.consume(TokenType.NUMBER, message);
        return parseInt(token.value);
    }

    private signedLiteral(message: string): number {
        const negative = this.match(TokenType.MINUS);
        const value = this.literalNumber(message);
        return negative ? -value : value;
    }

    private allocSlot(): number {
        if (this.nextSlot >= 64) {
            throw new Error('Out of variable slots (64 max)');
        }
        return this.nextSlot++;
    }

    private variableSlot(token: Token): number {
        const slot = this.variables.get(token.value);
        if (slot === undefined) {
            throw new Error(`Unknown variable '${token.value}' at line ${token.line}`);
        }
        return slot;
    }

    private consumeWord(word: string, message: string): Token {
        const token = this.consumeName(message);
        if (token.value !== word) throw new Error(message + " at line " + token.line);
        return token;
    }

    // Keywords double as names inside declarations and parameter lists.
    private consumeName(message: string): Token {
        if (this.isAtEnd()) throw new Error(message + " at line " + this.peek().line);
        return this.advance();
    }

    private isExpressionContinuation(offset: number): boolean {
        const token = this.tokens[this.current + offset];
        if (!token) return false;
        return token.type === TokenType.PLUS || token.type === TokenType.EQ ||
               token.type === TokenType.NEQ;
    }

    private fieldKey(moduleName: string, fieldName: string): string {
        return `${moduleName}.${fieldName}`;
    }

    private getFieldSlot(moduleName: string, fieldName: string): number {
        const slot = this.fieldSlots.get(this.fieldKey(moduleName, fieldName));
        if (slot === undefined) {
            throw new Error(`No allocated slot for ${moduleName}.${fieldName}`);
        }
        return slot;
    }

    private emitByte(b: number) {
        this.bytes.push(b & 0xFF);
    }

    private emitU32(value: number) {
        this.emitByte((value >> 24) & 0xFF);
        this.emitByte((value >> 16) & 0xFF);
        this.emitByte((value >> 8) & 0xFF);
        this.emitByte(value & 0xFF);
    }

    private emitF32(value: number) {
        const buf = new DataView(new ArrayBuffer(4));
        buf.setFloat32(0, value, false);   // big-endian, like every other operand
        for (let i = 0; i < 4; i++) this.emitByte(buf.getUint8(i));
    }

    // Whole numbers go out exact (as int32); anything else as a float.
    private emitPushNumber(value: number) {
        if (Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
            this.emitByte(OP.PUSH_INT);
            this.emitU32(value >>> 0);
            return;
        }
        this.emitByte(OP.PUSH_NUM);
        this.emitF32(value);
    }

    // Emits a jump with a placeholder offset; returns where to patch it.
    private emitJump(opcode: number): number {
        this.emitByte(opcode);
        this.emitByte(0);
        this.emitByte(0);
        return this.bytes.length - 2;
    }

    private patchJump(at: number) {
        const offset = this.bytes.length - (at + 2);
        this.bytes[at] = (offset >> 8) & 0xFF;
        this.bytes[at + 1] = offset & 0xFF;
    }

    private emitLoop(target: number) {
        this.emitByte(OP.JUMP);
        const offset = target - (this.bytes.length + 2);
        this.emitByte((offset >> 8) & 0xFF);
        this.emitByte(offset & 0xFF);
    }

    private emitSleepOpcode(opcode: number, value: number) {
        this.emitByte(opcode);
        this.emitU32(value);
    }

    private skipLine() {
        while (!this.check(TokenType.NEWLINE) && !this.check(TokenType.DEDENT) && !this.isAtEnd()) {
            this.advance();
        }
        this.consumeOptionalNewline();
    }

    private skipNewlines() {
        while (this.check(TokenType.NEWLINE)) this.advance();
    }

    private consumeOptionalNewline() {
        if (this.check(TokenType.NEWLINE)) this.advance();
    }

    private match(...types: TokenType[]): boolean {
        for (const type of types) {
            if (this.check(type)) {
                this.advance();
                return true;
            }
        }
        return false;
    }

    private check(type: TokenType): boolean {
        if (this.isAtEnd()) return false;
        return this.peek().type === type;
    }

    private advance(): Token {
        if (!this.isAtEnd()) this.current++;
        return this.previous();
    }

    private isAtEnd(): boolean {
        return this.peek().type === TokenType.EOF;
    }

    private peek(): Token {
        const token = this.tokens[this.current];
        if (token === undefined) {
            throw new Error(`Unexpected end of token stream at index ${this.current}`);
        }
        return token;
    }

    private peekNext(): Token | undefined {
        return this.tokens[this.current + 1];
    }

    private previous(): Token {
        const token = this.tokens[this.current - 1];
        if (token === undefined) {
            throw new Error(`No previous token available at index ${this.current - 1}`);
        }
        return token;
    }

    private consume(type: TokenType, message: string): Token {
        if (this.check(type)) return this.advance();
        throw new Error(message + " at line " + this.peek().line);
    }
}
