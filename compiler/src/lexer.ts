export enum TokenType {
    // Keywords
    CONFIG, USE, NUM, TEXT, BOOL, LIST, CLASS, FUNC,
    SET, PIN, HIGH, LOW, READ, ANALOG, AS, VOLTAGE,
    PULSE, ON, AT, HZ, MOVE, SERVO, TO,
    GET, DATA, FROM, PRINT, SLEEP, MS, S, US, MHZ,
    REPEAT, FOREVER, IF, ELSE,
    TRUE, FALSE, AND, OR, NOT,
    CLEAR, SHOW, LINE,

    // Identifiers and literals
    IDENTIFIER,
    NUMBER,
    STRING,

    // Operators
    ASSIGN,         // =
    PLUS,           // +
    MINUS,          // -
    MULTIPLY,       // *
    DIVIDE,         // /
    IDIV,           // //
    POWER,          // **
    MODULO,         // %
    BAND,           // &
    BOR,            // |
    BXOR,           // ^
    BNOT,           // ~
    SHL,            // <<
    SHR,            // >>
    EQ,             // ==
    NEQ,            // !=
    GT,             // >
    LT,             // <
    GTE,            // >=
    LTE,            // <=

    // Punctuation
    COLON,          // :
    DOT,            // .
    COMMA,          // ,
    LPAREN,         // (
    RPAREN,         // )
    LBRACKET,       // [
    RBRACKET,       // ]

    // Formatting
    NEWLINE,
    INDENT,
    DEDENT,
    EOF,
}

export interface Token {
    type: TokenType;
    value: string;
    line: number;
    column: number;
}

const KEYWORDS: Record<string, TokenType> = {
    'config': TokenType.CONFIG,
    'use': TokenType.USE,
    'num': TokenType.NUM,
    'text': TokenType.TEXT,
    'bool': TokenType.BOOL,
    'list': TokenType.LIST,
    'class': TokenType.CLASS,
    'func': TokenType.FUNC,
    'set': TokenType.SET,
    'pin': TokenType.PIN,
    'high': TokenType.HIGH,
    'low': TokenType.LOW,
    'read': TokenType.READ,
    'analog': TokenType.ANALOG,
    'as': TokenType.AS,
    'voltage': TokenType.VOLTAGE,
    'pulse': TokenType.PULSE,
    'on': TokenType.ON,
    'at': TokenType.AT,
    'hz': TokenType.HZ,
    'move': TokenType.MOVE,
    'servo': TokenType.SERVO,
    'to': TokenType.TO,
    'get': TokenType.GET,
    'data': TokenType.DATA,
    'from': TokenType.FROM,
    'print': TokenType.PRINT,
    'sleep': TokenType.SLEEP,
    'ms': TokenType.MS,
    's': TokenType.S,
    'us': TokenType.US,
    'mhz': TokenType.MHZ,
    'repeat': TokenType.REPEAT,
    'forever': TokenType.FOREVER,
    'if': TokenType.IF,
    'else': TokenType.ELSE,
    'true': TokenType.TRUE,
    'false': TokenType.FALSE,
    'and': TokenType.AND,
    'or': TokenType.OR,
    'not': TokenType.NOT,
    'clear': TokenType.CLEAR,
    'show': TokenType.SHOW,
    'line': TokenType.LINE,
};

export class Lexer {
    private source: string;
    private position: number = 0;
    private line: number = 1;
    private column: number = 1;
    private indentStack: number[] = [0];
    private tokens: Token[] = [];
    constructor(source: string) {
        this.source = source.replace(/\r\n?/g, '\n'); // Normalize CRLF and lone CR
    }

    public tokenize(): Token[] {
        while (!this.isAtEnd()) {
            this.scanToken();
        }

        // Process dedents for any remaining indentation
        while (this.indentStack.length > 1) {
            this.indentStack.pop();
            this.addToken(TokenType.DEDENT, '');
        }

        this.addToken(TokenType.EOF, '');
        return this.tokens;
    }

    private scanToken() {
        const c = this.peek();

        if (c === '\n') {
            this.handleNewline();
            return;
        }

        if (this.isWhitespace(c)) {
            this.advance();
            return;
        }

        if (c === '#') {
            // Comment
            while (!this.isAtEnd() && this.peek() !== '\n') {
                this.advance();
            }
            return;
        }

        if (this.isAlpha(c)) {
            this.handleIdentifier();
            return;
        }

        if (this.isDigit(c)) {
            this.handleNumber();
            return;
        }

        if (c === '"') {
            this.handleString();
            return;
        }

        this.handleOperatorOrPunctuation();
    }

    private handleNewline() {
        this.advance(); // consume '\n'

        // Skip blank lines
        while (!this.isAtEnd() && this.peek() === '\n') {
            this.advance();
        }

        if (this.isAtEnd()) return;

        this.addToken(TokenType.NEWLINE, '\n');

        let indentLevel = 0;
        while (!this.isAtEnd() && (this.peek() === ' ' || this.peek() === '\t')) {
            if (this.advance() === '\t') {
                indentLevel += 4;
            } else {
                indentLevel += 1;
            }
        }

        // Ignore indentation if it's an empty line with comments
        if (this.peek() === '\n' || this.peek() === '#' || this.isAtEnd()) {
            return;
        }

        const currentIndent = this.indentStack[this.indentStack.length - 1] ?? 0;

        if (indentLevel > currentIndent) {
            this.indentStack.push(indentLevel);
            this.addToken(TokenType.INDENT, '');
        } else if (indentLevel < currentIndent) {
            while (
                this.indentStack.length > 1 &&
                (this.indentStack[this.indentStack.length - 1] ?? 0) > indentLevel
            ) {
                this.indentStack.pop();
                this.addToken(TokenType.DEDENT, '');
            }
            if (this.indentStack[this.indentStack.length - 1] !== indentLevel) {
                throw new Error(`[${this.line}:${this.column}] Indentation error.`);
            }
        }
    }

    private handleIdentifier() {
        const start = this.position;
        while (!this.isAtEnd() && (this.isAlphaNumeric(this.peek()) || this.peek() === '_')) {
            this.advance();
        }

        const value = this.source.substring(start, this.position);

        // Handle special suffixes attached to numbers like 500ms -> [500] [ms]
        // In our spec: "133mhz", "500ms"
        // Wait, 133mhz starts with a digit, handleNumber should catch it

        const type = KEYWORDS[value] ?? TokenType.IDENTIFIER;
        // Adjust column offset manually since advance() increments it
        this.tokens.push({
            type,
            value,
            line: this.line,
            column: this.column - value.length
        });
    }

    private handleNumber() {
        // 0x1F / 0b1010: the token carries the value in decimal.
        const prefix = this.peekNext().toLowerCase();
        if (this.peek() === '0' && (prefix === 'x' || prefix === 'b')) {
            const column = this.column;
            this.advance();
            this.advance();
            const digit = prefix === 'x' ? /[0-9a-fA-F]/ : /[01]/;
            let digits = '';
            while (!this.isAtEnd() && (digit.test(this.peek()) || this.peek() === '_')) {
                const d = this.advance();
                if (d !== '_') digits += d;
            }
            if (!digits || this.isAlphaNumeric(this.peek())) {
                throw new Error(`[${this.line}:${column}] Bad ${prefix === 'x' ? 'hex' : 'binary'} number — like ${prefix === 'x' ? '0x1F' : '0b1010'}.`);
            }
            this.tokens.push({ type: TokenType.NUMBER, value: String(parseInt(digits, prefix === 'x' ? 16 : 2)), line: this.line, column });
            return;
        }
        const start = this.position;
        while (!this.isAtEnd() && this.isDigit(this.peek())) {
            this.advance();
        }

        if (this.peek() === '.' && this.isDigit(this.peekNext())) {
            this.advance(); // consume '.'
            while (!this.isAtEnd() && this.isDigit(this.peek())) {
                this.advance();
            }
        }

        const value = this.source.substring(start, this.position);
        this.tokens.push({
            type: TokenType.NUMBER,
            value,
            line: this.line,
            column: this.column - value.length
        });

        // Check for attached units e.g., 500ms, 133mhz
        if (this.isAlpha(this.peek())) {
            this.handleIdentifier(); // Handle 'ms', 'mhz', etc. as separate tokens
        }
    }

    private handleString() {
        const startLine = this.line;
        const startColumn = this.column;
        this.advance(); // Consume '"'
        const escapes: Record<string, string> = { '"': '"', '\\': '\\', 'n': '\n', 't': '\t' };
        let value = '';

        // Strings end at the line: a missing quote is reported where it began,
        // instead of swallowing the rest of the file.
        while (!this.isAtEnd() && this.peek() !== '"' && this.peek() !== '\n') {
            const c = this.advance();
            if (c === '\\') {
                const e = this.isAtEnd() ? '' : this.advance();
                if (!(e in escapes)) {
                    throw new Error(`[${this.line}:${this.column - 1}] Unknown escape '\\${e}' (use \\" \\\\ \\n or \\t).`);
                }
                value += escapes[e];
            } else {
                value += c;
            }
        }

        if (this.peek() !== '"') {
            throw new Error(`[${startLine}:${startColumn}] Unterminated string — add a closing ".`);
        }
        this.advance(); // Consume closing '"'

        this.tokens.push({
            type: TokenType.STRING,
            value,
            line: this.line,
            column: startColumn
        });
    }

    private handleOperatorOrPunctuation() {
        const c = this.advance();

        switch (c) {
            case ':': this.addToken(TokenType.COLON, c); break;
            case '.': this.addToken(TokenType.DOT, c); break;
            case ',': this.addToken(TokenType.COMMA, c); break;
            case '(': this.addToken(TokenType.LPAREN, c); break;
            case ')': this.addToken(TokenType.RPAREN, c); break;
            case '[': this.addToken(TokenType.LBRACKET, c); break;
            case ']': this.addToken(TokenType.RBRACKET, c); break;
            case '+': this.addToken(TokenType.PLUS, c); break;
            case '-': this.addToken(TokenType.MINUS, c); break;
            case '*':
                if (this.match('*')) this.addTokenOffset(TokenType.POWER, '**', 2);
                else this.addToken(TokenType.MULTIPLY, c);
                break;
            case '/':
                if (this.match('/')) this.addTokenOffset(TokenType.IDIV, '//', 2);
                else this.addToken(TokenType.DIVIDE, c);
                break;
            case '%': this.addToken(TokenType.MODULO, c); break;
            case '&': this.addToken(TokenType.BAND, c); break;
            case '|': this.addToken(TokenType.BOR, c); break;
            case '^': this.addToken(TokenType.BXOR, c); break;
            case '~': this.addToken(TokenType.BNOT, c); break;
            case '=':
                if (this.match('=')) {
                    this.addTokenOffset(TokenType.EQ, '==', 2);
                } else {
                    this.addTokenOffset(TokenType.ASSIGN, '=', 1);
                }
                break;
            case '!':
                if (this.match('=')) {
                    this.addTokenOffset(TokenType.NEQ, '!=', 2);
                } else {
                    throw new Error(`[${this.line}:${this.column}] Unexpected character '!'.`);
                }
                break;
            case '>':
                if (this.match('>')) {
                    this.addTokenOffset(TokenType.SHR, '>>', 2);
                } else if (this.match('=')) {
                    this.addTokenOffset(TokenType.GTE, '>=', 2);
                } else {
                    this.addTokenOffset(TokenType.GT, '>', 1);
                }
                break;
            case '<':
                if (this.match('<')) {
                    this.addTokenOffset(TokenType.SHL, '<<', 2);
                } else if (this.match('=')) {
                    this.addTokenOffset(TokenType.LTE, '<=', 2);
                } else {
                    this.addTokenOffset(TokenType.LT, '<', 1);
                }
                break;
            default: {
                // Name invisible/look-alike characters (e.g. a pasted non-breaking space).
                const code = c.codePointAt(0)!;
                const shown = code > 0x20 && code < 0x7F ? `'${c}'` : `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
                throw new Error(`[${this.line}:${this.column}] Unexpected character ${shown}.`);
            }
        }
    }

    private addToken(type: TokenType, value: string) {
        this.tokens.push({
            type,
            value,
            line: this.line,
            column: Math.max(1, this.column - 1)
        });
    }

    private addTokenOffset(type: TokenType, value: string, offset: number) {
        this.tokens.push({
            type,
            value,
            line: this.line,
            column: Math.max(1, this.column - offset)
        });
    }

    private advance(): string {
        const char = this.source[this.position];
        if (char === undefined) {
            throw new Error(`Unexpected end of source at index ${this.position}`);
        }
        this.position++;
        if (char === '\n') {
            this.line++;
            this.column = 1;
        } else {
            this.column++;
        }
        return char;
    }

    private peek(): string {
        if (this.isAtEnd()) return '\0';
        return this.source[this.position] ?? '\0';
    }

    private peekNext(): string {
        if (this.position + 1 >= this.source.length) return '\0';
        return this.source[this.position + 1] ?? '\0';
    }

    private match(expected: string): boolean {
        if (this.isAtEnd()) return false;
        if (this.source[this.position] !== expected) return false;
        this.position++;
        this.column++;
        return true;
    }

    private isAtEnd(): boolean {
        return this.position >= this.source.length;
    }

    private isWhitespace(c: string): boolean {
        return c === ' ' || c === '\t' || c === '\r';
    }

    private isDigit(c: string): boolean {
        return c >= '0' && c <= '9';
    }

    private isAlpha(c: string): boolean {
        return (c >= 'a' && c <= 'z') ||
               (c >= 'A' && c <= 'Z') ||
               c === '_';
    }

    private isAlphaNumeric(c: string): boolean {
        return this.isAlpha(c) || this.isDigit(c);
    }
}
