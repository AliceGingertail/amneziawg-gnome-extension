import {gettext as _} from './i18n.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseServers} from './serverParser.js';
import {parseTunnelSettings} from './tunnelConfig.js';

// Owns file I/O and monitoring, but knows nothing about menu widgets. onUpdate
// receives {servers, message, loading?}; only safe display data leaves this module.
export class ServerStore {
    constructor(settings, onUpdate) {
        this._settings = settings;
        this._onUpdate = onUpdate;
        this._destroyed = false;
        this._timer = 0;
        this._monitor = null;
        this._cancellable = null;
        this._records = new Map();
        this._pathChangedId = settings.connect('changed::config-path', () => this._open());
        this._open();
    }

    _open() {
        this._stopIO();
        this._records.clear();
        const path = this._settings.get_string('config-path');
        const expanded = path.startsWith('~/')
            ? GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]) : path;
        if (!GLib.path_is_absolute(expanded)) {
            this._onUpdate({servers: [], message: _('Specify an absolute configuration path in settings')});
            return;
        }
        this._file = Gio.File.new_for_path(expanded);
        try {
            // Watch the directory because Qt can save via atomic file replacement.
            // WATCH_MOVES also reports renames; check both sides of each event.
            this._monitor = this._file.get_parent().monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connect('changed', (_monitor, file, otherFile) => {
                if (!file?.equal(this._file) && !otherFile?.equal(this._file))
                    return;
                // Cancel an older read immediately so stale results cannot reach
                // the menu while waiting for the new write to settle.
                this._cancellable?.cancel();
                if (this._timer)
                    GLib.Source.remove(this._timer);
                this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    this._timer = 0;
                    this.reload();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch {
            // A missing parent or unavailable monitor must not prevent loading.
            // Reopening the menu also reloads, allowing recovery without a monitor.
        }
        this.reload();
    }

    reload() {
        if (this._destroyed || !this._file)
            return;
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._onUpdate({servers: [], message: _('Loading servers…'), loading: true});
        this._file.load_contents_async(cancellable, (file, result) => {
            try {
                const [, bytes] = file.load_contents_finish(result);

                if (this._destroyed || cancellable.is_cancelled())
                    return;

                const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
                const records = parseServers(text);
                this._records = this._index(records);
                
                const servers = [...this._records].map(([id, server]) => {
                    const name = typeof server.description === 'string' && server.description.trim()
                        ? server.description.trim() : _('Unnamed server');
                    
                    const hostName = typeof server.hostName === 'string' && server.hostName.trim()
                        ? server.hostName.trim() : _('No IP address');
                    
                    return {id, name, hostName};
                });

                this._onUpdate({ servers, message: servers.length ? '' : _('No servers') });
                
            } catch (error) {
                if (this._destroyed || cancellable.is_cancelled())
                    return;
                this._records.clear();
                const message = error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)
                    ? _('Configuration file not found')
                    : error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED)
                        ? _('Configuration file access denied')
                        : _('Failed to read the server list');
                // Do not log raw exceptions: configs contain credentials and keys.
                this._onUpdate({servers: [], message});
            }
        });
    }

    _stopIO() {
        this._file = null;
        this._cancellable?.cancel();
        this._monitor?.cancel();
        this._monitor = null;
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._timer = 0;
    }

    getServer(id) {
        return this._records.get(id) ?? null;
    }

    _index(servers) {
        const result = new Map();
        for (const server of servers) {
            const identity = [server.hostName, server.port, server.userName, server.defaultContainer];
            const base = typeof server.storageServerId === 'string' && server.storageServerId
                ? server.storageServerId
                : GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, JSON.stringify(identity), -1);
            let id = base;
            let suffix = 1;
            while (result.has(id))
                id = `${base}:${suffix++}`;
            result.set(id, server);
        }
        return result;
    }

    getConnection(id, cancellable) {
        const file = this._file;
        if (!file || this._destroyed)
            return Promise.reject(new Error(_('The configuration file is unavailable')));
        return new Promise((resolve, reject) => {
            file.load_contents_async(cancellable, (source, result) => {
                try {
                    const [, bytes] = source.load_contents_finish(result);
                    if (this._destroyed || cancellable?.is_cancelled() || !this._file?.equal(file))
                        throw new Error();
                    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
                    const records = this._index(parseServers(text));
                    resolve({server: records.get(id) ?? null, settings: parseTunnelSettings(text)});
                } catch {
                    reject(new Error(_('Failed to reload the configuration before connecting')));
                }
            });
        });
    }

    destroy() {
        // Called before the menu disappears: callbacks must never touch dead UI.
        this._destroyed = true;
        this._settings.disconnect(this._pathChangedId);
        this._stopIO();
        this._records.clear();
        this._onUpdate = null;
    }
}
