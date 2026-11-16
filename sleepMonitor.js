import {gettext as _, format} from './i18n.js';
import Gio from 'gi://Gio';

// Listen on the system bus; a session bus would disappear at logout.
export class SleepMonitor {
    constructor(onSleep, onError) {
        this._destroyed = false;
        this._cancellable = new Gio.Cancellable();
        this._subscriptions = [];
        this._proxies = [];
        const watch = (name, path, iface, ready) => {
            Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START,
                null, name, path, iface, this._cancellable, (_source, result) => {
                    try {
                        const proxy = Gio.DBusProxy.new_for_bus_finish(result);
                        if (this._destroyed)
                            return;
                        this._proxies.push(proxy);
                        if (!proxy.get_name_owner()) {
                            onError(format(_('Experimental reconnect: %s is unavailable'), name));
                            return;
                        }
                        ready(proxy);
                        console.log('[AmneziaWG] monitoring logind PrepareForSleep');
                    } catch {
                        if (!this._destroyed)
                            onError(format(_('Experimental reconnect: failed to monitor %s'), name));
                    }
                });
        };
        watch('org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', proxy => {
                this._subscriptions.push([proxy, proxy.connect('g-signal', (_proxy, _sender, signal, parameters) => {
                    if (signal === 'PrepareForSleep') {
                        const sleeping = parameters.deep_unpack()[0];
                        console.log(`[AmneziaWG] PrepareForSleep(${sleeping})`);
                        onSleep(sleeping);
                    }
                })]);
            });
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        for (const [proxy, id] of this._subscriptions)
            proxy.disconnect(id);
        this._subscriptions = [];
        this._proxies = [];
    }
}
