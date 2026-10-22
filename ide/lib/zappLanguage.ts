// Monaco language support for Zapp: tokens, hover documentation, and
// completion that knows the loaded modules and the selected board's pins.
import type { Monaco } from '@monaco-editor/react';
import type * as monacoApi from 'monaco-editor';
import type { ModuleDefinition } from '../../compiler/src/emitter';
import { DOCS } from './zappDocs';

const KEYWORDS = [
    'config', 'use', 'num', 'text', 'bool', 'list', 'class', 'func',
    'set', 'pin', 'high', 'low', 'read', 'analog', 'as', 'voltage',
    'pulse', 'on', 'at', 'hz', 'move', 'servo', 'to',
    'get', 'data', 'from', 'print', 'sleep', 'ms', 's', 'us', 'mhz',
    'repeat', 'forever', 'if', 'else', 'true', 'false', 'and', 'or', 'not',
    'clear', 'show', 'display', 'size', 'line', 'type', 'press', 'click', 'scroll', 'mouse',
    'pixel', 'pixels', 'brightness',
    'connect', 'wifi', 'http', 'post', 'ip', 'connected', 'with',
    'advertise', 'notify', 'ble', 'message', 'spi', 'i2c', 'uart',
    'whole', 'decimal', 'bytes', 'byte', 'send', 'transfer', 'cs', 'bit', 'of', 'length',
    'signed', 'unsigned', 'big', 'little', 'endian',
];
const MATH = ['abs', 'round', 'floor', 'ceil', 'sqrt', 'sin', 'cos', 'tan', 'min', 'max', 'clamp', 'map', 'random'];

const SNIPPETS: [label: string, insert: string, doc: string][] = [
    ['repeat forever', 'repeat forever:\n    ${1:print "tick"}', 'Loop until the board is stopped'],
    ['repeat n',       'repeat ${1:5}:\n    ${2:print "x"}', 'Loop a fixed number of times'],
    ['if else',        'if ${1:x > 0}:\n    ${2:print "yes"}\nelse:\n    print "no"', 'Branch on a condition'],
    ['func',           'func ${1:name} ${2:arg}:\n    ${3:print arg}', 'Define a function'],
    ['config i2c',     'config:\n    i2c sda=${1:SDA} scl=${2:SCL}', 'Pick I2C pins (only if not the board\'s usual SDA/SCL)'],
    ['config uart',    'config:\n    uart tx=${1:0} rx=${2:1} baud=${3:9600}', 'Configure the UART'],
    ['config spi',     'config:\n    spi mosi=${1:19} miso=${2:16} sck=${3:18} cs=${4:17}', 'Configure the SPI bus'],
    ['connect wifi',   'connect wifi to "${1:network}" with "${2:password}"', 'Join a Wi-Fi network (Pico W)'],
    ['set pin',        'set pin ${1:LED} ${2|high,low|}', 'Turn a pin on or off'],
    ['pulse',          'pulse ${1:128} on pin ${2:10} at ${3:1000}hz', 'PWM output'],
    ['move servo',     'move servo on pin ${1:12} to ${2:90}', 'Servo angle, -90 to 90'],
    ['read analog',    'read analog pin ${1:26} as voltage', 'Read an ADC pin'],
    ['get data',       'get data from ${1:bmp280}', 'Read every field of a module'],
    ['send to i2c',    'send ${1:[0x00, 0x01]} to i2c ${2:0x3C}', 'Write bytes to an I2C chip'],
    ['read from i2c',  'bytes ${1:raw} = read ${2:2} bytes from i2c ${3:0x68} at ${4:0x3B}', 'Read registers from an I2C chip'],
    ['spi transfer',   'bytes ${1:reply} = spi transfer ${2:[0x9F, 0, 0, 0]} with cs ${3:5}', 'Swap bytes with an SPI chip'],
    ['display text','display on ${1:oled} ${2:"Hello"}', 'Text on the next OLED line'],
    ['display text at','display on ${1:oled} ${2:"Hello"} at ${3:0} ${4:0} size ${5:1}', 'Text at x y pixels, scaled 1-4'],
];

// Words a statement can start with (snippets cover the multi-word ones).
const STARTERS = ['set', 'read', 'print', 'sleep', 'repeat', 'if', 'else', 'func', 'use', 'get',
    'clear', 'show', 'pulse', 'move', 'num', 'whole', 'decimal', 'text', 'bool', 'bytes', 'send',
    'type', 'press', 'click', 'advertise', 'notify'];
const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta', 'pink', 'white', 'off'];

const isScreen = (name: string) => modules[name]?.interface === 'display';

// The board's pin names, one per GPIO, friendliest first (LED before GP25).
function boardPinNames(): string[] {
    const rank = (n: string) => (/^GP\d+$/.test(n) ? 2 : /^[AD]\d+$/.test(n) ? 1 : 0);
    const seen = new Set<number>();
    return Object.keys(pins).sort((a, b) => rank(a) - rank(b))
        .filter((n) => !seen.has(pins[n]!) && seen.add(pins[n]!));
}

// What the program declares so far: parts in use, variables, functions.
function scan(source: string) {
    const all = (re: RegExp) => [...source.matchAll(re)].map((m) => m[1]!);
    return {
        used: all(/^\s*use\s+(\w+)/gm),
        vars: all(/^\s*(?:num|whole|decimal|text|bool|bytes)\s+(\w+)/gm),
        funcs: all(/^\s*func\s+(\w+)/gm),
        hasConfig: /^\s*config\s*:/m.test(source),
    };
}

// Updated by the workbench whenever modules or the board change, so the
// providers below always complete against what is actually loaded.
let modules: Record<string, ModuleDefinition> = {};
let pins: Record<string, number> = {};

export function setLanguageContext(next: {
    modules?: Record<string, ModuleDefinition>;
    pins?: Record<string, number>;
}) {
    if (next.modules) modules = next.modules;
    if (next.pins) pins = next.pins;
}

function docFor(word: string): string[] | null {
    const doc = DOCS[word];
    if (!doc) return null;
    return [
        `**${doc.title}** — ${doc.summary}`,
        '```zapp\n' + doc.syntax + '\n```',
        ...(doc.example ? ['```zapp\n' + doc.example + '\n```'] : []),
    ];
}

export function registerZappLanguage(monaco: Monaco) {
    if (monaco.languages.getLanguages().some((l: { id: string }) => l.id === 'zapp')) return;

    monaco.languages.register({ id: 'zapp' });

    monaco.languages.setMonarchTokensProvider('zapp', {
        keywords: KEYWORDS,
        tokenizer: {
            root: [
                [/#.*$/, 'comment'],
                [/"(?:[^"\\]|\\.)*"/, 'string'],
                [/\b0[xX][0-9a-fA-F_]+\b|\b0[bB][01_]+\b|\b\d+(\.\d+)?\b/, 'number'],
                [/\b[a-zA-Z_]\w*\.\w+/, 'variable.predefined'],
                [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
                [/[=<>!+\-*/%&|^~]+/, 'operator'],
                [/[:,.()[\]]/, 'delimiter'],
            ],
        },
    });

    monaco.languages.setLanguageConfiguration('zapp', {
        comments: { lineComment: '#' },
        brackets: [['(', ')'], ['[', ']']],
        autoClosingPairs: [
            { open: '(', close: ')' },
            { open: '[', close: ']' },
            { open: '"', close: '"' },
        ],
        onEnterRules: [{
            beforeText: /:\s*$/,
            action: { indentAction: monaco.languages.IndentAction.Indent },
        }],
    });

    // Hover
    monaco.languages.registerHoverProvider('zapp', {
        provideHover: (model: monacoApi.editor.ITextModel, position: monacoApi.Position) => {
            const word = model.getWordAtPosition(position);
            if (!word) return null;

            // module.field → what the .zappmod says about that reading
            const line = model.getLineContent(position.lineNumber);
            const qualified = line.slice(0, word.endColumn - 1).match(/(\w+)\.(\w+)$/);
            if (qualified) {
                const module = modules[qualified[1]!];
                const field = module?.fields[qualified[2]!];
                if (module && field) {
                    const parts = [
                        `**${module.name}.${qualified[2]}** — ${field.type ?? 'num'} over ${module.interface}`,
                    ];
                    if (field.reg !== undefined && field.len) {
                        parts.push(`register \`0x${field.reg.toString(16).toUpperCase()}\`, ${field.len} bytes`);
                    }
                    if (field.transform) parts.push(`transform \`${field.transform}\``);
                    if (field.parse) parts.push(`parser \`${field.parse}\``);
                    return { contents: parts.map((value) => ({ value })) };
                }
            }

            const doc = docFor(word.word);
            return doc ? { contents: doc.map((value) => ({ value })) } : null;
        },
    });

    // Completion
    monaco.languages.registerCompletionItemProvider('zapp', {
        triggerCharacters: ['.', ' '],
        provideCompletionItems: (model: monacoApi.editor.ITextModel, position: monacoApi.Position) => {
            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };
            const Kind = monaco.languages.CompletionItemKind;
            const Snippet = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
            const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
            // The statement typed so far, minus the word being completed.
            const stmt = before.trimStart().slice(0, before.trimStart().length - word.word.length);
            const ctx = scan(model.getValue());

            const items = (labels: string[], kind: number, detail?: (l: string) => string) => ({
                suggestions: labels.map((label, i) => ({
                    label, kind, insertText: label, range, sortText: String(i).padStart(3, '0'),
                    ...(detail ? { detail: detail(label) } : {}),
                })),
            });
            const none = { suggestions: [] };

            // Exactly one thing fits after these.
            if (/\buse\s+$/.test(stmt)) {
                return items(Object.keys(modules).filter((m) => !ctx.used.includes(m)).sort(), Kind.Module,
                    (m) => modules[m]!.interface === 'display' ? 'screen' : Object.keys(modules[m]!.fields).join(', '));
            }
            const dotted = before.match(/(\w+)\.\w*$/);
            if (dotted) {
                const module = modules[dotted[1]!];
                return module ? items(Object.keys(module.fields), Kind.Field, (f) => module.fields[f]!.type ?? 'num') : none;
            }
            if (/\bpin\s+$/.test(stmt)) {
                const names = boardPinNames();
                return names.length ? items(names, Kind.Constant, (n) => `GP${pins[n]}`) : none;
            }
            if (/^set\s+pin\s+\S+\s+$/.test(stmt)) return items(['high', 'low'], Kind.Keyword);
            if (/^set\s+pixels?\b.*\bto\s+$/.test(stmt)) return items(COLORS, Kind.Color);
            if (/^set\s+$/.test(stmt)) return items(['pin', 'pixels', 'pixel', 'brightness'], Kind.Keyword);
            if (/^(display\s+on|clear)\s+$/.test(stmt)) return items(ctx.used.filter(isScreen), Kind.Module);
            if (/^get\s+data\s+from\s+$/.test(stmt)) return items(ctx.used.filter((m) => !isScreen(m)), Kind.Module);
            if (/^repeat\s+$/.test(stmt)) return items(['forever'], Kind.Keyword);
            if (/^read\s+$/.test(stmt)) return items(['pin', 'analog'], Kind.Keyword);
            if (/\bbytes\s+from\s+$/.test(stmt) || /^send\s+.+\bto\s+$/.test(stmt)) return items(['i2c', 'spi'], Kind.Keyword);
            if (/\bspi\s+$/.test(stmt) && !/^send/.test(stmt)) return items(['transfer'], Kind.Keyword);
            if (/\bas\s+$/.test(stmt) && !/analog/.test(stmt)) return items(['signed 16-bit', 'unsigned 16-bit', 'signed 8-bit', 'unsigned 24-bit'], Kind.Keyword);

            // Start of a line: statements.
            if (stmt === '') {
                const hasScreen = ctx.used.some(isScreen);
                const snippets = SNIPPETS.filter(([label]) =>
                    (!label.startsWith('display') || hasScreen) && (!label.startsWith('config') || !ctx.hasConfig));
                return {
                    suggestions: [
                        ...snippets.map(([label, insertText, documentation], i) => ({
                            label, kind: Kind.Snippet, insertText, documentation, range,
                            insertTextRules: Snippet, sortText: `a${String(i).padStart(3, '0')}`,
                        })),
                        ...STARTERS.filter((k) => (k !== 'clear' || hasScreen) && (k !== 'get' || ctx.used.some((m) => !isScreen(m))))
                            .map((label) => ({ label, kind: Kind.Keyword, insertText: label, range, sortText: `b${label}` })),
                        ...ctx.funcs.map((label) => ({ label, kind: Kind.Function, insertText: label, range, sortText: `c${label}` })),
                    ],
                };
            }

            // Where a value goes: variables, sensor fields, a few value words.
            if (/(^print|^if|^display\s+on\s+\w+|[=+\-*/%(<>&|^~,]|\b(and|or|not|repeat|else|to|of))\s*$/.test(stmt)) {
                return {
                    suggestions: [
                        ...ctx.vars.map((label) => ({ label, kind: Kind.Variable, insertText: label, range, sortText: `a${label}` })),
                        ...ctx.used.filter((m) => !isScreen(m)).flatMap((m) => Object.keys(modules[m]?.fields ?? {}).map((f) => ({
                            label: `${m}.${f}`, kind: Kind.Field, insertText: `${m}.${f}`, range, sortText: `b${m}${f}`,
                        }))),
                        ...['read pin', 'true', 'false', 'not', 'length of', 'bit'].map((label) => ({ label, kind: Kind.Keyword, insertText: label, range, sortText: `c${label}` })),
                        ...MATH.map((label) => ({ label, kind: Kind.Function, insertText: label, range, sortText: `d${label}` })),
                    ],
                };
            }
            return none;
        },
    });

    // Black and white, like the rest of the IDE: weight and grey do the work.
    monaco.editor.defineTheme('zapp-dark', {
        // JetBrains New UI Dark colours.
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: '', foreground: 'd5d7dc' },
            { token: 'keyword', foreground: 'e0a07c' },
            { token: 'string', foreground: '7fc186' },
            { token: 'number', foreground: '3cc2cf' },
            { token: 'comment', foreground: '969aa2', fontStyle: 'italic' },
            { token: 'variable.predefined', foreground: 'd894cc' },
            { token: 'operator', foreground: 'd5d7dc' },
        ],
        // Matches --surface / --border in app/globals.css.
        colors: {
            'editor.background': '#1e1f22',
            'editor.foreground': '#d5d7dc',
            'editor.lineHighlightBackground': '#26282e',
            'editor.lineHighlightBorder': '#00000000',
            'editorGutter.background': '#1e1f22',
            'editorLineNumber.foreground': '#737884',
            'editorLineNumber.activeForeground': '#d5d7dc',
            'editorIndentGuide.background1': '#43454a',
            'editorCursor.foreground': '#ced0d6',
            'editor.selectionBackground': '#2a539f',
            'editorWidget.background': '#2b2d30',
            'editorWidget.border': '#43454a',
            'editorSuggestWidget.background': '#2b2d30',
            'editorSuggestWidget.border': '#43454a',
            'editorSuggestWidget.selectedBackground': '#2e436e',
            'editorSuggestWidget.selectedForeground': '#dfe1e5',
            'editorSuggestWidget.highlightForeground': '#548af7',
            'editorSuggestWidget.focusHighlightForeground': '#548af7',
            'editorHoverWidget.background': '#2b2d30',
            'editorHoverWidget.border': '#43454a',
            'editorError.foreground': '#ff7b85',
        },
    });
}

/** Formatting on save: 4-space indent, no trailing whitespace, no double blanks. */
export function formatZapp(source: string): string {
    const out: string[] = [];
    let blanks = 0;
    for (const raw of source.split('\n')) {
        const line = raw.replace(/\s+$/, '').replace(/^\t+/, (tabs) => '    '.repeat(tabs.length));
        if (line === '') {
            if (++blanks > 1) continue;
        } else {
            blanks = 0;
        }
        out.push(line);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n') + '\n';
}
