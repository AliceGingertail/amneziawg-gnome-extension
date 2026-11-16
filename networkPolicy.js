import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function networkRange(value) {
    if (typeof value !== 'string')
        throw new Error('Некорректная запись IP в split tunneling');
    const parts = value.trim().split('/');
    const ip = Gio.InetAddress.new_from_string(parts[0]);
    if (!ip || parts.length > 2)
        return null;
    const isIpv6 = ip.get_family() === Gio.SocketFamily.IPV6;
    const range = parts.length === 1 ? (isIpv6 ? 128 : 32) : Number(parts[1]);
    if ((parts.length === 2 && !/^\d+$/.test(parts[1])) ||
        !Number.isInteger(range) || range < 0 || range > (isIpv6 ? 128 : 32))
        throw new Error('Некорректная подсеть в split tunneling');
    const canonical = ip.to_string();
    let bytes;
    if (isIpv6) {
        const expanded = canonical.replace(/(\d+\.\d+\.\d+\.\d+)$/, value => {
            const octets = value.split('.').map(Number);
            return `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
        });
        const halves = expanded.split('::');
        const left = halves[0] ? halves[0].split(':') : [];
        const right = halves[1] ? halves[1].split(':') : [];
        const groups = halves.length === 1 ? left
            : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
        bytes = Uint8Array.from(groups.flatMap(group => {
            const value = parseInt(group, 16);
            return [value >> 8, value & 255];
        }));
    } else {
        bytes = Uint8Array.from(canonical.split('.').map(Number));
    }
    for (let bit = range; bit < bytes.length * 8; bit++)
        bytes[Math.floor(bit / 8)] &= ~(1 << (7 - bit % 8));
    return {address: Gio.InetAddress.new_from_bytes(bytes,
        isIpv6 ? Gio.SocketFamily.IPV6 : Gio.SocketFamily.IPV4).to_string(), range, isIpv6};
}

function resolveHost(host, parent) {
    return new Promise((resolve, reject) => {
        const cancellable = new Gio.Cancellable();
        const cancellationId = parent?.connect(() => cancellable.cancel());
        let settled = false;
        let timer = 0;
        const finish = (error, addresses) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                GLib.Source.remove(timer);
            timer = 0;
            if (cancellationId)
                parent.disconnect(cancellationId);
            cancellable.cancel();
            if (error)
                reject(error);
            else
                resolve(addresses);
        };
        if (parent?.is_cancelled()) {
            finish(new Error('Подготовка маршрутов отменена'));
            return;
        }
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
            timer = 0;
            finish(new Error('Истекло время разрешения домена split tunneling'));
            return GLib.SOURCE_REMOVE;
        });
        Gio.Resolver.get_default().lookup_by_name_async(host, cancellable, (resolver, result) => {
            try {
                const addresses = resolver.lookup_by_name_finish(result).map(ip => ip.to_string());
                if (!addresses.length)
                    throw new Error();
                finish(null, addresses);
            } catch {
                finish(new Error('Не удалось разрешить домен split tunneling'));
            }
        });
    });
}

export async function applyTunnelPolicy(payload, settings = {}, cancellable = null, lookup = resolveHost) {
    if (settings.policyError)
        throw new Error(settings.policyError);
    if (!settings.sitesSplitTunnelingEnabled || settings.routeMode === 0)
        return payload;
    if (![1, 2].includes(settings.routeMode))
        throw new Error('Неизвестный режим split tunneling');
    const full = payload.allowedIPAddressRanges.length === 2 &&
        payload.allowedIPAddressRanges.some(net => net.address === '0.0.0.0' && net.range === 0) &&
        payload.allowedIPAddressRanges.some(net => net.address === '::' && net.range === 0);
    if (!full || !settings.sites?.length)
        return payload;
    const operation = new Gio.Cancellable();
    const cancellationId = cancellable?.connect(() => operation.cancel());
    if (cancellable?.is_cancelled())
        operation.cancel();
    let timedOut = false;
    let timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
        timer = 0;
        timedOut = true;
        operation.cancel();
        return GLib.SOURCE_REMOVE;
    });
    const results = new Array(settings.sites.length);
    let next = 0;
    const worker = async () => {
        while (next < settings.sites.length) {
            if (operation.is_cancelled())
                throw new Error('Подготовка маршрутов отменена');
            const index = next++;
            const entry = settings.sites[index];
            const direct = networkRange(entry.site);
            if (direct) {
                results[index] = [direct];
                continue;
            }
            const host = entry.site.trim();
            if (!host || /[\s/:?#@]/u.test(host) || /^\d+(\.\d+)+$/.test(host))
                throw new Error('Некорректный домен или IP в split tunneling');
            const cached = entry.addresses.map(value => {
                const range = networkRange(value);
                if (!range)
                    throw new Error('Некорректный сохранённый IP в split tunneling');
                return range;
            });
            let resolved = [];
            try {
                resolved = await lookup(host, operation);
                if (!Array.isArray(resolved) || !resolved.length)
                    throw new Error();
            } catch {
                if (operation.is_cancelled())
                    throw new Error('Подготовка маршрутов отменена');
                if (!cached.length)
                    throw new Error('Не удалось разрешить домен split tunneling; сохранённых IP нет');
            }
            results[index] = [...cached, ...resolved.map(value => {
                const range = networkRange(value);
                if (!range)
                    throw new Error('Некорректный результат DNS для split tunneling');
                return range;
            })];
        }
    };
    try {
        await Promise.all(Array.from({length: Math.min(4, settings.sites.length)}, () => worker()));
        if (operation.is_cancelled())
            throw new Error('Подготовка маршрутов отменена');
    } catch (error) {
        if (timedOut)
            throw new Error('Истекло время подготовки split tunneling');
        throw error;
    } finally {
        if (timer)
            GLib.Source.remove(timer);
        operation.cancel();
        if (cancellationId)
            cancellable.disconnect(cancellationId);
    }
    const unique = ranges => [...new Map(ranges.map(net => [`${net.address}/${net.range}`, net])).values()];
    const routes = unique(results.flat());
    if (settings.routeMode === 1) {
        const dns = [payload.primaryDnsServer, payload.secondaryDnsServer].filter(Boolean)
            .map(value => networkRange(value));
        payload.allowedIPAddressRanges = unique([...routes, ...dns]);
    } else {
        payload.excludedAddresses = [...new Set([...payload.excludedAddresses,
            ...routes.map(net => `${net.address}/${net.range}`)])];
    }
    return payload;
}
