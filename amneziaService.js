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
                this._fail('Служба Amnezia не отвечает');
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
                        this._fail('Служба Amnezia недоступна');
                }
            });
    }

    _send(message) {
        if (!this._connection)
            throw new Error('Нет соединения со службой Amnezia');
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
                        this._fail('Ошибка отправки команды службе Amnezia');
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
                        throw new Error('Соединение со службой закрыто');
                    const buffer = new Uint8Array(this._buffer.length + bytes.length);
                    buffer.set(this._buffer);
                    buffer.set(bytes, this._buffer.length);
                    this._buffer = buffer;
                    if (buffer.length > 65536)
                        throw new Error('Ответ службы слишком большой');
                    let newline;
                    while ((newline = this._buffer.indexOf(10)) !== -1) {
                        let message;
                        try {
                            message = JSON.parse(new TextDecoder('utf-8', {fatal: true})
                                .decode(this._buffer.slice(0, newline)));
                        } catch {
                            throw new Error('Некорректный ответ службы');
                        }
                        this._buffer = this._buffer.slice(newline + 1);
                        this._handle(message);
                    }
                    this._read(generation);
                } catch {
                    if (generation === this._generation && !this._destroyed)
                        this._fail('Ошибка чтения состояния службы Amnezia');
                }
            });
    }

    _handle(message) {
        if (message?.type === 'status') {
            if (typeof message.connected !== 'boolean')
                throw new Error('Некорректное состояние службы');
            this._lastStatus = GLib.get_monotonic_time();
            this.status = {
                connected: message.connected,
                gateway: typeof message.serverIpv4Gateway === 'string' ? message.serverIpv4Gateway : '',
                address: typeof message.deviceIpv4Address === 'string' ? message.deviceIpv4Address : '',
            };
            if (this._pending?.type === 'deactivate' && !message.connected)
                this._settle();
            this._onUpdate({available: true, ...this.status});
        } else if (message?.type === 'connected') {
            if (this._pending?.type === 'activate' && message.pubkey === this._pending.publicKey)
                this._settle();
            this._send({type: 'status'});
        } else if (message?.type === 'disconnected') {
            if (this._pending?.type === 'deactivate')
                this._settle();
            else if (this._pending)
                this._settle(new Error('Служба не смогла подключить VPN'));
            this.status = {connected: false, gateway: '', address: ''};
            this._onUpdate({available: true, ...this.status});
        } else if (message?.type === 'backendFailure') {
            this._settle(new Error('Служба сообщила об ошибке VPN'));
            this._onUpdate({available: true, ...this.status, error: 'Ошибка VPN в службе Amnezia'});
            this._send({type: 'status'});
        }
    }

    command(payload) {
        if (!this._connection || !this.status)
            return Promise.reject(new Error('Состояние службы пока неизвестно'));
        if (this._pending)
            return Promise.reject(new Error('Дождитесь завершения предыдущей команды'));
        if (!['activate', 'deactivate'].includes(payload.type))
            return Promise.reject(new Error('Неизвестная команда VPN'));
        return new Promise((resolve, reject) => {
            const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._commandTimeoutMs, () => {
                if (this._pending)
                    this._pending.timer = 0;
                this._settle(new Error('Служба не подтвердила подключение или отключение VPN'));
                this._send({type: 'status'});
                return GLib.SOURCE_REMOVE;
            });
            this._pending = {type: payload.type, publicKey: payload.serverPublicKey, resolve, reject, timer};
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
        this._settle(new Error('Соединение со службой Amnezia потеряно'));
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
            finish(new Error('Служба Amnezia не ответила вовремя'));
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
                                throw new Error('Служба Amnezia закрыла соединение');
                            const combined = new Uint8Array(buffer.length + bytes.length);
                            combined.set(buffer);
                            combined.set(bytes, buffer.length);
                            buffer = combined;
                            if (buffer.length > 65536)
                                throw new Error('Слишком большой ответ службы Amnezia');
                            let newline;
                            while ((newline = buffer.indexOf(10)) !== -1) {
                                let message;
                                try {
                                    message = JSON.parse(new TextDecoder('utf-8', {fatal: true})
                                        .decode(buffer.slice(0, newline)));
                                } catch {
                                    throw new Error('Некорректный ответ службы Amnezia');
                                }
                                buffer = buffer.slice(newline + 1);
                                if (message?.type !== 'status')
                                    continue;
                                if (typeof message.connected !== 'boolean')
                                    throw new Error('В ответе службы отсутствует состояние VPN');
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
                            finish(new Error('Не удалось отправить запрос службе Amnezia'));
                        }
                    });
            } catch {
                finish(new Error('Не удалось подключиться к службе Amnezia'));
            }
        });
    });
}
