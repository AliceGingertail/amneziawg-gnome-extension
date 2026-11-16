import {gettext as _} from './i18n.js';
export function parseServers(text) {
    const match = text.match(/^\s*serversList\s*=(.*)$/m);
    if (!match)
        throw new Error(_('The configuration is missing serversList'));
    let value = match[1].trim();
    if (value.startsWith('"') && value.endsWith('"'))
        value = value.slice(1, -1);
    if (value.startsWith('@ByteArray(') && value.endsWith(')'))
        value = value.slice(11, -1);

    // Decode the OUTER Qt escaping first. JSON.parse below handles the second,
    // JSON layer. Do not replace every backslash blindly: JSON strings may
    // contain their own escaped quotes, newlines, and protocol configurations.
    let decoded = '';
    for (let i = 0; i < value.length; i++) {
        if (value[i] !== '\\') {
            decoded += value[i];
            continue;
        }
        if (++i === value.length)
            throw new Error(_('Invalid escape sequence in serversList'));
        const escapes = {n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', f: '\f', v: '\v'};
        if (value[i] === 'x') {
            const hex = value.slice(i + 1).match(/^[0-9a-fA-F]{1,4}/)?.[0];
            if (!hex)
                throw new Error(_('Invalid hexadecimal code in serversList'));
            decoded += String.fromCharCode(parseInt(hex, 16));
            i += hex.length;
        } else {
            decoded += escapes[value[i]] ?? value[i];
        }
    }

    let servers;
    try {
        servers = JSON.parse(decoded);
    } catch {
        // Never expose JSON.parse's error: it may include private source text.
        throw new Error(_('Failed to parse the server list JSON'));
    }
    if (!Array.isArray(servers) || servers.some(server =>
        !server || typeof server !== 'object' || Array.isArray(server)))
        throw new Error(_('Invalid server list structure'));
    return servers;
}
