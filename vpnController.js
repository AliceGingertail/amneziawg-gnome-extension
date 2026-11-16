import Gio from 'gi://Gio';
import {AmneziaService} from './amneziaService.js';
import {buildTunnelConfig} from './tunnelConfig.js';
import {applyTunnelPolicy} from './networkPolicy.js';

export class VpnController {
    constructor(settings, store, onUpdate, serviceOptions = {}) {
        this._settings = settings;
        this._store = store;
        this._onUpdate = onUpdate;
        this._servers = [];
        this._destroyed = false;
        this._busy = false;
        this._error = '';
        this._status = {available: false, connected: false};
        this._resolverCancellation = new Gio.Cancellable();
        this._service = new AmneziaService(status => {
            const recovered = !this._status.available && status.available;
            this._status = status;
            if (status.error)
                this._error = status.error;
            else if (recovered)
                this._error = '';
            this._emit();
        }, serviceOptions);
        this._service.start();
    }

    setServers(servers) {
        this._servers = servers;
        this._emit();
    }

    _activeServer() {
        if (!this._status.connected || !this._status.gateway || !this._status.address)
            return null;
        const matches = this._servers.filter(server => {
            const record = this._store.getServer(server.id);
            try {
                const entry = record?.containers?.find(item => item.container === record.defaultContainer);
                const config = JSON.parse((entry?.awg ?? entry?.wireguard)?.last_config ?? 'null');
                return config?.hostName === this._status.gateway &&
                    config?.client_ip?.split('/')[0] === this._status.address;
            } catch {
                return false;
            }
        });
        return matches.length === 1 ? matches[0] : null;
    }

    _emit() {
        if (this._destroyed)
            return;
        const active = this._activeServer();
        this._onUpdate({
            available: this._status.available,
            connected: this._status.connected && !(this._busy && !this._disconnecting),
            busy: this._busy,
            activeServerId: active?.id ?? null,
            activeServerName: active?.name ?? null,
            message: this._busy ? (this._disconnecting ? 'Отключение…' : 'Подключение…')
                : this._error || (this._status.available ? '' : 'Проверка службы Amnezia…'),
        });
    }

    async toggle() {
        if (this._destroyed || this._busy)
            return;
        this._error = '';
        this._busy = true;
        this._disconnecting = this._status.connected;
        this._emit();
        try {
            if (!this._status.available)
                throw new Error('Служба Amnezia недоступна');
            if (this._disconnecting) {
                await this._service.command({type: 'deactivate'});
            } else {
                const selected = this._settings.get_string('selected-server-id');
                const {server, settings: tunnelSettings} = await this._store.getConnection(
                    selected, this._resolverCancellation);
                if (this._destroyed)
                    return;
                if (!server)
                    throw new Error('Выберите доступный сервер в меню');
                const payload = buildTunnelConfig(server, tunnelSettings);
                let endpoint = Gio.InetAddress.new_from_string(payload.serverIpv4AddrIn);
                if (!endpoint) {
                    endpoint = await new Promise((resolve, reject) => {
                        Gio.Resolver.get_default().lookup_by_name_async(payload.serverIpv4AddrIn,
                            this._resolverCancellation, (resolver, result) => {
                                try {
                                    const addresses = resolver.lookup_by_name_finish(result);
                                    const ipv4 = addresses.find(ip => ip.get_family() === Gio.SocketFamily.IPV4);
                                    if (!ipv4)
                                        throw new Error();
                                    resolve(ipv4);
                                } catch {
                                    reject(new Error('Не удалось определить IPv4-адрес VPN-сервера'));
                                }
                            });
                    });
                }
                if (endpoint.get_family() !== Gio.SocketFamily.IPV4)
                    throw new Error('Пока поддерживаются только IPv4-адреса VPN-серверов');
                if (this._destroyed)
                    return;
                const host = endpoint.to_string();
                payload.serverIpv4AddrIn = host;
                payload.serverIpv4Gateway = host;
                payload.excludedAddresses = [host];
                await applyTunnelPolicy(payload, tunnelSettings, this._resolverCancellation);
                if (this._destroyed)
                    return;
                await this._service.command(payload);
            }
        } catch (error) {
            if (!this._destroyed)
                this._error = error.message;
        } finally {
            this._busy = false;
            this._emit();
        }
    }

    destroy() {
        this._destroyed = true;
        this._resolverCancellation.cancel();
        this._service.destroy();
        this._onUpdate = null;
    }
}
