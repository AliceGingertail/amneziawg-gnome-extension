import {gettext as _} from './i18n.js';
export function readConfValues(text) {
    const sections = new Map();
    let section = 'General';
    const lines = text.replace(/^\uFEFF/, '').replace(/\\\r?\n/g, '').split(/\r?\n/);
    for (const line of lines) {
        const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (header) {
            section = header[1];
            continue;
        }
        if (/^\s*[;#]/.test(line))
            continue;
        const match = line.match(/^\s*([^=]+?)\s*=(.*)$/);
        if (!match)
            continue;
        if (!sections.has(section))
            sections.set(section, new Map());
        sections.get(section).set(match[1], match[2].trim());
    }
    return sections.get('Conf') ?? sections.get('General') ?? new Map();
}

export function decodeIniValue(raw) {
    let result = '';
    let quoted = false;
    const values = [];
    for (let i = 0; i < raw.length; i++) {
        const char = raw[i];
        if (char === '"') {
            quoted = !quoted;
        } else if (char === ',' && !quoted) {
            values.push(result.trim());
            result = '';
        } else if (char === ';' && !quoted) {
            break;
        } else if (char === '\\') {
            if (++i >= raw.length)
                throw new Error(_('Invalid escape sequence in Qt settings'));
            const named = {a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
                '"': '"', "'": "'", '?': '?', '\\': '\\'};
            if (raw[i] in named) {
                result += named[raw[i]];
            } else {
                const hex = raw[i] === 'x';
                const match = raw.slice(hex ? i + 1 : i).match(hex ? /^[0-9a-fA-F]+/ : /^[0-7]+/);
                if (!match)
                    throw new Error(_('Unsupported escape sequence in Qt settings'));
                let number = 0;
                for (const digit of match[0])
                    number = (number * (hex ? 16 : 8) + parseInt(digit, hex ? 16 : 8)) & 0xffff;
                result += String.fromCharCode(number);
                i += match[0].length - (hex ? 0 : 1);
            }
        } else {
            result += char;
        }
    }
    if (quoted)
        throw new Error(_('Unterminated string in Qt settings'));
    if (values.length) {
        values.push(result.trim());
        return values;
    }
    return result.trim();
}

export function decodeVariant(raw) {
    const decoded = decodeIniValue(raw);
    if (typeof decoded !== 'string' || !decoded.startsWith('@Variant(') || !decoded.endsWith(')'))
        throw new Error(_('The site list uses an unsupported Qt format'));
    const binary = decoded.slice(9, -1);
    if (binary.length > 1048576 || [...binary].some(char => char.charCodeAt(0) > 255))
        throw new Error(_('Invalid QVariant size or encoding'));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    let offset = 0;
    let nodes = 0;
    const fail = () => { throw new Error(_('Corrupted or unsupported QVariant list')); };
    const uint = () => {
        if (offset + 4 > bytes.length)
            fail();
        const value = view.getUint32(offset, false);
        offset += 4;
        return value;
    };
    const count = () => {
        const value = uint();
        if (value > 10000)
            fail();
        return value;
    };
    const string = () => {
        const length = uint();
        if (length === 0xffffffff)
            return '';
        if (length % 2 || offset + length > bytes.length)
            fail();
        let value = '';
        const end = offset + length;
        for (; offset < end; offset += 2)
            value += String.fromCharCode(view.getUint16(offset, false));
        return value;
    };
    const variant = (depth = 0) => {
        if (depth > 8 || ++nodes > 10000)
            fail();
        const type = uint();
        if (type === 8) {
            const result = new Map();
            const length = count();
            for (let i = 0; i < length; i++) {
                const name = string();
                if (result.has(name))
                    fail();
                result.set(name, variant(depth + 1));
            }
            return result;
        }
        if (type === 9 || type === 11) {
            const result = [];
            const length = count();
            for (let i = 0; i < length; i++)
                result.push(type === 11 ? string() : variant(depth + 1));
            return result;
        }
        if (type === 10)
            return string();
        fail();
    };
    const result = variant();
    if (offset !== bytes.length)
        fail();
    return result;
}
