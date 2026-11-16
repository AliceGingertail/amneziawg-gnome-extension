import Gio from 'gi://Gio';
import {readConfValues, decodeIniValue, decodeVariant} from './qtSettings.js';

const AWG_KEYS = ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4',
    'I1', 'I2', 'I3', 'I4', 'I5', 'HeaderProtectionKey', 'ContentPaddingAddition',
    'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout',
    'MaxHandshakeAttempts', 'RandomTrailers', 'DisableCookies'];

function key(value, optional = false) {
    if (optional && !value)
        return '';
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value))
        throw new Error('В сохранённой конфигурации некорректный ключ VPN');
    return value;
}

export function parseTunnelSettings(text) {
    const values = readConfValues(text);
    const settings = {};
    try {
        const read = (name, fallback) => values.has(name) ? decodeIniValue(values.get(name)) : fallback;
        const boolean = (name, fallback) => {
            const value = read(name, fallback ? 'true' : 'false');
            if (!['true', 'false', '1', '0'].includes(value))
                throw new Error('Некорректный флаг в настройках VPN');
            return value === 'true' || value === '1';
        };
        settings.primaryDns = read('primaryDns', '1.1.1.1');
        settings.secondaryDns = read('secondaryDns', '1.0.0.1');
        settings.useAmneziaDns = boolean('useAmneziaDns', true);
        settings.killSwitchEnabled = boolean('killSwitchEnabled', true);
        settings.strictKillSwitchEnabled = boolean('strictKillSwitchEnabled', false);
        settings.appsSplitTunnelingEnabled = boolean('appsSplitTunnelingEnabled', false);
        settings.sitesSplitTunnelingEnabled = boolean('sitesSplitTunnelingEnabled', false);
        const mode = read('routeMode', '0');

        if (!['0', '1', '2'].includes(mode))
            throw new Error('Неизвестный режим split tunneling');

        settings.routeMode = Number(mode);
        const dns = read('allowedDnsServers', []);
        settings.allowedDnsServers = Array.isArray(dns) ? dns : dns ? [dns] : [];

        if (settings.allowedDnsServers.some(value => !Gio.InetAddress.new_from_string(value)))
            throw new Error('Некорректный список разрешённых DNS');

        settings.sites = [];
        if (settings.sitesSplitTunnelingEnabled && settings.routeMode !== 0) {

            const name = settings.routeMode === 1 ? 'ForwardSites' : 'ExceptSites';
            const sites = values.has(name) ? decodeVariant(values.get(name)) : new Map();

            if (!(sites instanceof Map))
                throw new Error('Некорректный список сайтов split tunneling');
            for (const [site, value] of sites) {
                const addresses = typeof value === 'string' ? [value] : value;
                if (!Array.isArray(addresses) || addresses.some(address => typeof address !== 'string'))
                    throw new Error('Неподдерживаемые записи списка сайтов');
                settings.sites.push({site, addresses: addresses.filter(Boolean)});
            }
        }
    } catch (error) {
        settings.policyError = error.message;
    }
    return settings;
}

export function buildTunnelConfig(server, settings = {}) {
    if (settings.policyError)
        throw new Error(settings.policyError);
    if (settings.strictKillSwitchEnabled)
        throw new Error('Строгий kill switch пока не поддерживается расширением');
    if (settings.appsSplitTunnelingEnabled)
        throw new Error('Split tunneling приложений пока не поддерживается расширением');

    const container = server?.defaultContainer;

    if (!['amnezia-awg', 'amnezia-awg2', 'amnezia-wireguard'].includes(container))
        throw new Error('Пока поддерживаются только AmneziaWG и WireGuard');

    const entry = server.containers?.find(item => item.container === container);
    const protocol = container === 'amnezia-wireguard' ? 'wireguard' : 'awg';
    const cached = entry?.[protocol]?.last_config;
    if (typeof cached !== 'string' || !cached)
        throw new Error('Нет готового конфига: сначала подключите этот сервер в AmneziaVPN');
    let config;
    try {
        config = JSON.parse(cached);
    } catch {
        throw new Error('Сохранённая конфигурация туннеля повреждена');
    }
    if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new Error('Сохранённая конфигурация туннеля повреждена');

    const port = Number(config.port);
    const address = typeof config.client_ip === 'string' ? config.client_ip.split('/')[0] : '';
    
    if (!Gio.InetAddress.new_from_string(address) || address.includes(':'))
        throw new Error('В конфигурации отсутствует IPv4-адрес клиента');
    if (!Number.isInteger(port) || port < 1 || port > 65535 ||
        typeof config.hostName !== 'string' || !config.hostName.trim())
        throw new Error('В конфигурации некорректный адрес или порт сервера');

    const directives = {};
    for (const line of (typeof config.config === 'string' ? config.config : '').split('\n')) {
        const match = line.match(/^\s*([A-Za-z0-9]+)\s*=\s*(.*?)\s*$/);
        if (match)
            directives[match[1]] = match[2];
    }
    const internalDns = settings.useAmneziaDns && server.containers?.some(item => item.container === 'amnezia-dns');
    const primary = internalDns ? '172.29.172.254' : settings.primaryDns ?? '';
    const secondary = internalDns ? '' : settings.secondaryDns ?? '';
    const dnsText = (directives.DNS ?? '$PRIMARY_DNS, $SECONDARY_DNS')
        .replaceAll('$PRIMARY_DNS', primary).replaceAll('$SECONDARY_DNS', secondary);
    const dns = (internalDns ? primary : dnsText).split(',').map(value => value.trim()).filter(Boolean);
    if (!dns.length || dns.some(value => !Gio.InetAddress.new_from_string(value)))
        throw new Error('В сохранённой конфигурации отсутствуют корректные DNS-серверы');
    let allowed = config.allowed_ips;
    if (typeof allowed === 'string')
        allowed = allowed.split(',').map(value => value.trim());
    if (allowed === undefined)
        allowed = directives.AllowedIPs?.split(',').map(value => value.trim());
    if (!Array.isArray(allowed) || !allowed.length)
        throw new Error('В конфигурации отсутствует список AllowedIPs');
    const ranges = allowed.map(value => {
        if (typeof value !== 'string')
            throw new Error('Некорректный список AllowedIPs');
        const parts = value.trim().split('/');
        const ip = Gio.InetAddress.new_from_string(parts[0]);
        const isIpv6 = parts[0].includes(':');
        const range = parts.length === 1 ? (isIpv6 ? 128 : 32) : Number(parts[1]);
        if (!ip || parts.length > 2 || parts[1] === '' || !Number.isInteger(range) ||
            range < 0 || range > (isIpv6 ? 128 : 32))
            throw new Error('Некорректная сеть в AllowedIPs');
        return {address: parts[0], range, isIpv6};
    });
    const configuredMtu = Number(config.mtu ?? 0);
    const mtu = configuredMtu === 0 ? 1420 : configuredMtu;
    const keepalive = String(config.persistent_keep_alive ?? directives.PersistentKeepalive ?? '0');
    const keepaliveParts = keepalive.split('-').map(Number);
    const validKeepalive = /^\d+(?:-\d+)?$/.test(keepalive) &&
        keepaliveParts.every(value => value >= 0 && value <= 65535) &&
        (keepaliveParts.length === 1 || (protocol === 'awg' && keepaliveParts[0] <= keepaliveParts[1]));
    if (!Number.isInteger(mtu) || mtu < 576 || mtu > 65535 ||
        !validKeepalive)
        throw new Error('Некорректные параметры MTU или keepalive');
    const payload = {
        type: 'activate',
        privateKey: key(config.client_priv_key),
        serverPublicKey: key(config.server_pub_key),
        serverPskKey: key(config.psk_key, true),
        deviceIpv4Address: address,
        deviceIpv6Address: 'fd58:baa6:dead::1',
        deviceMTU: String(mtu),
        serverIpv4AddrIn: config.hostName.trim(),
        serverIpv4Gateway: config.hostName.trim(),
        serverPort: port,
        persistentKeepalive: String(keepalive),
        primaryDnsServer: dns[0],
        secondaryDnsServer: dns[1] ?? '',
        allowedIPAddressRanges: ranges,
        excludedAddresses: [config.hostName.trim()],
        vpnDisabledApps: [],
        allowedDnsServers: settings.allowedDnsServers ?? dns,
        killSwitchOption: settings.killSwitchEnabled ? 'true' : 'false',
    };
    if (protocol === 'awg') {
        for (const name of AWG_KEYS) {
            const value = config[name] ?? directives[name];
            if (value !== undefined && value !== '')
                payload[name] = String(value);
        }
    }
    return payload;
}
