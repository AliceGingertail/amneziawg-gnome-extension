import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {gettext as _} from './i18n.js';

// /proc/net/route exposes the main IPv4 routing table. Ignore the tunnel itself.
export function defaultInterfaces(text) {
    const interfaces = new Set();
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 8 || fields[0] === 'Iface')
            continue;
        const [iface, destination, gateway, flagText] = fields;
        const flags = Number.parseInt(flagText, 16);
        if (iface === 'amn0' || iface === 'lo' || !/^[\w.:-]+$/.test(iface) ||
            destination !== '00000000' || fields[7] !== '00000000' ||
            !/^[\da-f]{8}$/i.test(gateway) || gateway === '00000000' ||
            !/^[\da-f]+$/i.test(flagText) || (flags & 3) !== 3 || (flags & 0x200))
            continue;
        interfaces.add(iface);
    }
    return [...interfaces];
}

export function linkReady(operstate, flags) {
    return ['up', 'unknown'].includes(operstate.trim()) &&
        /^0x[\da-f]+\s*$/i.test(flags) && (Number.parseInt(flags, 16) & 1) !== 0;
}

function readText(path, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, result) => {
            try {
                const [, bytes] = file.load_contents_finish(result);
                resolve(new TextDecoder().decode(bytes));
            } catch (error) {
                reject(error);
            }
        });
    });
}

export async function checkUnderlay(cancellable) {
    let routes;
    try {
        routes = await readText('/proc/net/route', cancellable);
    } catch {
        throw new Error(_('Failed to inspect the underlying network routes'));
    }
    for (const iface of defaultInterfaces(routes)) {
        try {
            const [state, flags] = await Promise.all([
                readText(`/sys/class/net/${iface}/operstate`, cancellable),
                readText(`/sys/class/net/${iface}/flags`, cancellable),
            ]);
            if (linkReady(state, flags))
                return true;
        } catch {
            // An interface can disappear while NetworkManager rebuilds the link.
        }
    }
    return false;
}

export class UnderlayWaiter {
    constructor({check = checkUnderlay, pollMs = 500, timeoutMs = 45000} = {}) {
        this._check = check;
        this._pollMs = pollMs;
        this._timeoutMs = timeoutMs;
        this._finish = null;
    }

    wait(isCurrent) {
        this.cancel();
        return new Promise((resolve, reject) => {
            const cancellable = new Gio.Cancellable();
            let timer = 0;
            let deadline = 0;
            let settled = false;
            const finish = (error = null, ready = false) => {
                if (settled)
                    return;
                settled = true;
                this._finish = null;
                if (timer)
                    GLib.Source.remove(timer);
                if (deadline)
                    GLib.Source.remove(deadline);
                cancellable.cancel();
                if (error)
                    reject(error);
                else
                    resolve(ready);
            };
            this._finish = finish;
            deadline = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timeoutMs, () => {
                deadline = 0;
                if (!isCurrent())
                    finish();
                else
                    finish(new Error(_('No underlying IPv4 gateway became available after wake')));
                return GLib.SOURCE_REMOVE;
            });
            const check = async () => {
                if (settled)
                    return;
                if (!isCurrent()) {
                    finish();
                    return;
                }
                try {
                    const ready = await this._check(cancellable);
                    if (settled)
                        return;
                    if (!isCurrent()) {
                        finish();
                        return;
                    }
                    if (ready) {
                        finish(null, true);
                        return;
                    }
                    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._pollMs, () => {
                        timer = 0;
                        check();
                        return GLib.SOURCE_REMOVE;
                    });
                } catch (error) {
                    if (!settled)
                        finish(isCurrent() ? error : null);
                }
            };
            check();
        });
    }

    cancel() {
        this._finish?.();
    }
}
