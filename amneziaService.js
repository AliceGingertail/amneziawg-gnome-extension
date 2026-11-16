import {gettext as _} from './i18n.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function defaultSocketPath() {
    return GLib.file_test('/var/run/amneziavpn/daemon.socket', GLib.FileTest.EXISTS)
        ? '/var/run/amneziavpn/daemon.socket' : '/tmp/amneziavpn.socket';
}

export class AmneziaService {
    constructor(onUpdate, {socketPath = null, pollMs = 3000, commandTimeoutMs = 30000} = {}) {
        this._onUpdate = onUpdate;
        this._socketPath = socketPath;
        this._pollMs = pollMs;
        this._commandTimeoutMs = commandTimeoutMs;
        this._generation = 0;
        this._connection = null;
        this._cancellable = null;
        this._timer = 0;
        this._reconnect = 0;
        this._pending = null;
        this._destroyed = false;
        this._queue = [];
        this._writing = false;
        this.status = null;
    }

    start() {
        if (this._destroyed || this._connection || this._cancellable)
            return;
        const generation = ++this._generation;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const client = new Gio.SocketClient();
        this._lastStatus = GLib.get_monotonic_time();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._pollMs, () => {
            if (GLib.get_monotonic_time() - this._lastStatus > Math.max(this._pollMs * 3, 3000) * 1000) {
                this._fail(_('The Amnezia service is not responding'));
                return GLib.SOURCE_REMOVE;
            }
            if (this._connection)
                this._send({type: 'status'});
            return GLib.SOURCE_CONTINUE;
        });
        client.connect_async(Gio.UnixSocketAddress.new(this._socketPath ?? defaultSocketPath()),
            cancellable, (source, result) => {
                try {
                    const connection = source.connect_finish(result);
                    if (generation !== this._generation || this._destroyed) {
                        connection.close(null);
                        return;
                    }
                    this._connection = connection;
                    this._buffer = new Uint8Array();
                    this._send({type: 'status'});
                    this._read(generation);
                } catch {
                    if (generation === this._generation && !this._destroyed)
                        this._fail(_('The Amnezia service is unavailable'));
                }
            });
    }

    _send(message) {
        if (!this._connection)
            throw new Error(_('Not connected to the Amnezia service'));
        this._queue.push(message);
        this._write();
    }

    _write() {
        if (this._writing || !this._queue.length || !this._connection)
            return;
        this._writing = true;
        const generation = this._generation;
        const data = new TextEncoder().encode(`${JSON.stringify(this._queue.shift())}\n`);
        this._connection.get_output_stream().write_all_async(data, GLib.PRIORITY_DEFAULT,
            this._cancellable, (stream, result) => {
                try {
                    stream.write_all_finish(result);
                    if (generation !== this._generation || this._destroyed)
                        return;
                    this._writing = false;
                    this._write();
                } catch {
                    if (generation === this._generation && !this._destroyed)
                        this._fail(_('Failed to send a command to the Amnezia service'));
                }
            });
    }

    _read(generation) {
        this._connection.get_input_stream().read_bytes_async(4096, GLib.PRIORITY_DEFAULT,
            this._cancellable, (stream, result) => {
                try {
                    const bytes = stream.read_bytes_finish(result).get_data();
                    if (generation !== this._generation || this._destroyed)
                        return;
                    if (!bytes?.length)
                        throw new Error(_('The service connection was closed'));
                    const buffer = new Uint8Array(this._buffer.length + bytes.length);
                    buffer.set(this._buffer);
                    buffer.set(bytes, this._buffer.length);
                    this._buffer = buffer;
                    if (buffer.length > 65536)
                        throw new Error(_('The service response is too large'));
                    let newline;
                    while ((newline = this._buffer.indexOf(10)) !== -1) {
                        let message;
                        try {
                            message = JSON.parse(new TextDecoder('utf-8', {fatal: true})
                                .decode(this._buffer.slice(0, newline)));
                        } catch {
                            throw new Error(_('Invalid service response'));
                        }
                        this._buffer = this._buffer.slice(newline + 1);
                        this._handle(message);
                    }
                    this._read(generation);
                } catch {
                    if (generation === this._generation && !this._destroyed)
                        this._fail(_('Failed to read the Amnezia service status'));
                }
            });
    }

    _handle(message) {
        if (message?.type === 'status') {
            if (typeof message.connected !== 'boolean')
                throw new Error(_('Invalid service status'));
            this._lastStatus = GLib.get_monotonic_time();
            this.status = {
                connected: message.connected,
                gateway: typeof message.serverIpv4Gateway === 'string' ? message.serverIpv4Gateway : '',
                address: typeof message.deviceIpv4Address === 'string' ? message.deviceIpv4Address : '',
            };
            if (this._pending && this._pending.lastConnected !== message.connected) {
                this._pending.lastConnected = message.connected;
                console.log(`[AmneziaWG] pending ${this._pending.type}: service status connected=${message.connected}`);
            }
            if (this._pending?.type === 'deactivate' && !message.connected)
                this._settle();
            this._onUpdate({available: true, ...this.status});
        } else if (message?.type === 'connected') {
            const matches = this._pending?.type === 'activate' && message.pubkey === this._pending.publicKey;
            console.log(`[AmneziaWG] connected event: matches pending activation=${Boolean(matches)}`);
            if (matches)
                this._settle();
            this._send({type: 'status'});
        } else if (message?.type === 'disconnected') {
            console.log(`[AmneziaWG] disconnected event: pending=${this._pending?.type ?? 'none'}`);
            if (this._pending?.type === 'deactivate')
                this._settle();
            else if (this._pending)
                this._settle(new Error(_('The service failed to connect the VPN')));
            this.status = {connected: false, gateway: '', address: ''};
            this._onUpdate({available: true, ...this.status});
        } else if (message?.type === 'backendFailure') {
            this._settle(new Error(_('The service reported a VPN error')));
            this._onUpdate({available: true, ...this.status, error: _('VPN error in the Amnezia service')});
            this._send({type: 'status'});
        }
    }

    command(payload) {
        if (!this._connection || !this.status)
            return Promise.reject(new Error(_('The service status is not yet known')));
        if (this._pending)
            return Promise.reject(new Error(_('Wait for the previous command to finish')));
        if (!['activate', 'deactivate'].includes(payload.type))
            return Promise.reject(new Error(_('Unknown VPN command')));
        return new Promise((resolve, reject) => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._commandTimeoutMs, () => {
                if (this._pending)
                    this._pending.timer = 0;
                console.log(`[AmneziaWG] ${payload.type} confirmation timed out; service status connected=${this.status?.connected ?? 'unknown'}`);
                const message = payload.type === 'activate'
                    ? _('The Amnezia service did not confirm VPN connection: no matching handshake event')
                    : _('The Amnezia service did not confirm VPN disconnection');
                this._settle(new Error(message));
                this._send({type: 'status'});
                return GLib.SOURCE_REMOVE;
            });
            this._pending = {type: payload.type, publicKey: payload.serverPublicKey, resolve, reject, timer};
            console.log(`[AmneziaWG] sending VPN command: ${payload.type}`);
            this._send(payload);
        });
    }

    _settle(error = null) {
        const pending = this._pending;
        if (!pending)
            return;
        this._pending = null;
        if (pending.timer)
            GLib.Source.remove(pending.timer);
        if (error)
            pending.reject(error);
        else
            pending.resolve();
    }

    _close() {
        ++this._generation;
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._connection) {
            try { this._connection.close(null); } catch {}
        }
        this._connection = null;
        this.status = null;
        this._queue = [];
        this._writing = false;
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._timer = 0;
        this._settle(new Error(_('Connection to the Amnezia service was lost')));
    }

    _fail(error) {
        this._close();
        if (this._destroyed)
            return;
        this._onUpdate({available: false, connected: false, error});
        this._reconnect = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            this._reconnect = 0;
            this.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._reconnect)
            GLib.Source.remove(this._reconnect);
        this._reconnect = 0;
        this._close();
        this._onUpdate = null;
    }
}

export function getServiceStatus({socketPath = null, timeoutMs = 3000} = {}) {
    const path = socketPath ?? defaultSocketPath();
    return new Promise((resolve, reject) => {
        const cancellable = new Gio.Cancellable();
        const client = new Gio.SocketClient();
        let connection = null;
        let settled = false;
        let timer = 0;
        const finish = (error, status = null) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                GLib.Source.remove(timer);
            timer = 0;
            cancellable.cancel();
            if (connection) {
                try { connection.close(null); } catch {}
            }
            if (error)
                reject(error);
            else
                resolve(status);
        };
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timer = 0;
            finish(new Error(_('The Amnezia service response timed out')));
            return GLib.SOURCE_REMOVE;
        });
        client.connect_async(Gio.UnixSocketAddress.new(path), cancellable, (source, result) => {
            try {
                connection = source.connect_finish(result);
                if (settled) {
                    connection.close(null);
                    return;
                }
                const output = connection.get_output_stream();
                const input = connection.get_input_stream();
                const request = new TextEncoder().encode('{"type":"status"}\n');
                let buffer = new Uint8Array();
                const read = () => input.read_bytes_async(4096, GLib.PRIORITY_DEFAULT,
                    cancellable, (stream, readResult) => {
                        try {
                            const bytes = stream.read_bytes_finish(readResult).get_data();
                            if (settled)
                                return;
                            if (!bytes?.length)
                                throw new Error(_('The Amnezia service closed the connection'));
                            const combined = new Uint8Array(buffer.length + bytes.length);
                            combined.set(buffer);
                            combined.set(bytes, buffer.length);
                            buffer = combined;
                            if (buffer.length > 65536)
                                throw new Error(_('The Amnezia service response is too large'));
                            let newline;
                            while ((newline = buffer.indexOf(10)) !== -1) {
                                let message;
                                try {
                                    message = JSON.parse(new TextDecoder('utf-8', {fatal: true})
                                        .decode(buffer.slice(0, newline)));
                                } catch {
                                    throw new Error(_('Invalid response from the Amnezia service'));
                                }
                                buffer = buffer.slice(newline + 1);
                                if (message?.type !== 'status')
                                    continue;
                                if (typeof message.connected !== 'boolean')
                                    throw new Error(_('The service response is missing the VPN status'));
                                finish(null, {
                                    connected: message.connected,
                                    txBytes: Number.isFinite(message.txBytes) ? message.txBytes : 0,
                                    rxBytes: Number.isFinite(message.rxBytes) ? message.rxBytes : 0,
                                    date: typeof message.date === 'string' ? message.date : null,
                                });
                                return;
                            }
                            read();
                        } catch (error) {
                            finish(error);
                        }
                    });
                output.write_all_async(request, GLib.PRIORITY_DEFAULT, cancellable,
                    (stream, writeResult) => {
                        try {
                            stream.write_all_finish(writeResult);
                            if (!settled)
                                read();
                        } catch {
                            finish(new Error(_('Failed to send a request to the Amnezia service')));
                        }
                    });
            } catch {
                finish(new Error(_('Failed to connect to the Amnezia service')));
            }
        });
    });
}
