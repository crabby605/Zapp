import { ModuleDefinition, ModuleFieldDefinition } from './emitter';

function parseScalar(raw: string): string | number {
    const value = raw.trim();

    if (value.startsWith('"') && value.endsWith('"')) {
        return value.slice(1, -1);
    }

    if (/^0x[0-9a-f]+$/i.test(value)) {
        return parseInt(value, 16);
    }

    if (/^\d+$/.test(value)) {
        return parseInt(value, 10);
    }

    if (/^-?\d+\.\d+$/.test(value)) {
        return parseFloat(value);
    }

    return value;
}

// section → [defaults for the sub-object, keys copied from the file].
// A key not listed here is ignored, so unknown//future keys can't corrupt a
// module definition.
const SECTIONS: Record<string, { defaults: object; keys: string[] }> = {
    i2c:     { defaults: { addr_default: 0 }, keys: ['addr_default', 'addr_alt'] },
    uart:    { defaults: { baud: 9600, bits: 8, parity: 'none', stop_bits: 1 },
               keys: ['baud', 'bits', 'parity', 'stop_bits', 'line_end'] },
    display: { defaults: { controller: '', width: 128, height: 64, addr: 0x3C },
               keys: ['controller', 'width', 'height', 'addr', 'addr_alt'] },
    spi:     { defaults: { mode: 0, freq_khz: 1000 },
               keys: ['mode', 'freq_khz', 'cs_active', 'bit_order'] },
};

const FIELD_KEYS = ['reg', 'len', 'transform', 'type', 'read', 'filter', 'parse',
                    'rx_len', 'bit_mask', 'bit_shift', 'scale'];

export function parseModuleFile(text: string): ModuleDefinition {
    let currentSection = '';
    const module: any = { fields: {} as Record<string, ModuleFieldDefinition> };

    for (const lineRaw of text.split(/\r?\n/)) {
        const line = lineRaw.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        if (line.startsWith('[') && line.endsWith(']')) {
            currentSection = line.slice(1, -1);
            continue;
        }

        const eqIndex = line.indexOf('=');
        if (eqIndex === -1) {
            continue;
        }

        const key = line.slice(0, eqIndex).trim();
        const value = parseScalar(line.slice(eqIndex + 1));
        const section = SECTIONS[currentSection];

        if (currentSection === 'module' && key === 'name') {
            module.name = value;
        } else if (currentSection === 'compat' && key === 'interface') {
            module.interface = value;
        } else if (section) {
            module[currentSection] ??= { ...section.defaults };
            if (section.keys.includes(key)) module[currentSection][key] = value;
        } else if (currentSection === 'init') {
            module.init ??= {};
            const reg = parseScalar(key);
            if (typeof reg === 'number' && typeof value === 'number') module.init[reg] = value;
        } else if (currentSection.startsWith('fields.')) {
            const fieldName = currentSection.slice('fields.'.length);
            module.fields[fieldName] ??= { reg: 0, len: 0, transform: '' };
            if (FIELD_KEYS.includes(key)) module.fields[fieldName][key] = value;
        }
    }

    if (typeof module.name !== 'string') {
        throw new Error('Module file is missing [module].name');
    }

    if (typeof module.interface !== 'string') {
        throw new Error(`Module '${module.name}' is missing compat.interface`);
    }

    return module as ModuleDefinition;
}
