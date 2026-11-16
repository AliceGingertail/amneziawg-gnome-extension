import {gettext as _} from './i18n.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {AmneziaService} from './amneziaService.js';
import {buildTunnelConfig} from './tunnelConfig.js';
import {applyTunnelPolicy} from './networkPolicy.js';
import {ResumeRecovery} from './resumeRecovery.js';
import {SleepMonitor} from './sleepMonitor.js';
import {UnderlayWaiter} from './underlayNetwork.js';

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
        this._underlayWaiter = new UnderlayWaiter();
        this._service = new AmneziaService(status => {
            const recovered = !this._status.available && status.available;
            this._status = status;
            if (status.error)
                this._error = status.error;
            else if (recovered)
                this._error = '';
            this._emit();
        }, serviceOptions);
        this._recovery = new ResumeRecovery({
            translate: _,
            getState: () => ({
                enabled: this._settings.get_boolean('experimental-resume-reconnect'),
                connected: this._status.connected,
                available: this._status.available,
                busy: this._busy,
                serverId: this._activeServer()?.id ?? this._settings.get_string('selected-server-id'),
            }),
            reconnect: (id, isCurrent) => this._reconnectAfterResume(id, isCurrent),
            schedule: (callback, delay) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            }),
            cancelSchedule: id => GLib.Source.remove(id),
            onError: message => {
                this._error = message;
                this._emit();
            },
        });
        const updateMonitor = () => {
            this._underlayWaiter.cancel();
            this._sleepMonitor?.destroy();
            this._sleepMonitor = null;
            this._recovery.reset();
            const enabled = this._settings.get_boolean('experimental-resume-reconnect');
            console.log(`[AmneziaWG] automatic sleep recovery ${enabled ? 'enabled' : 'disabled'}`);
            if (enabled) {
                this._sleepMonitor = new SleepMonitor(
                    sleeping => {
                        if (sleeping)
                            this._underlayWaiter.cancel();
                        this._recovery.prepareForSleep(sleeping);
                    },
                    message => {
                        this._error = message;
                        this._emit();
                    });
            }
        };
        this._resumeSettingId = settings.connect('changed::experimental-resume-reconnect', updateMonitor);
        updateMonitor();
        this._service.start();
    }

    setServers(servers) {
        this._servers = servers;
        this._emit();
    }

    setButtonActivator(activate) {
        this._activateButton = activate;
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
        this._recovery?.changed();
        this._onUpdate({
            available: this._status.available,
            connected: this._status.connected && !(this._busy && !this._disconnecting),
            busy: this._busy,
            activeServerId: active?.id ?? null,
            activeServerName: active?.name ?? null,
            message: this._waitingForUnderlay ? _('Waiting for the network gateway after wake…')
                : this._reconnecting ? _('Reconnecting after suspend (experimental)…')
                : this._busy ? (this._disconnecting ? _('Disconnecting…') : _('Connecting…'))
                : this._error || (this._status.available ? '' : _('Checking the Amnezia service…')),
        });
    }

    async toggle({automatic = false, isCurrent = () => true} = {}) {
        if (this._destroyed || this._busy || !isCurrent())
            return false;
        if (!automatic) {
            this._recovery.cancel();
            this._underlayWaiter.cancel();
        }
        this._error = '';
        this._busy = true;
        this._disconnecting = this._status.connected;
        this._emit();
        try {
            await this._setConnected(!this._disconnecting,
                this._settings.get_string('selected-server-id'), isCurrent);
            return !this._destroyed && isCurrent();
        } catch (error) {
            if (!this._destroyed)
                this._error = error.message;
            return false;
        } finally {
            this._busy = false;
            this._emit();
        }
    }

    // Called by the button's clicked handler, including programmatic clicks.
    async _setConnected(connected, serverId, isCurrent = () => true) {
        if (this._destroyed || !isCurrent())
            return;
        if (!this._status.available)
            throw new Error(_('The Amnezia service is unavailable'));
        if (!connected) {
            await this._service.command({type: 'deactivate'});
            return;
        }
        const payload = await this._preparePayload(serverId);
        if (!this._destroyed && isCurrent())
            await this._service.command(payload);
    }

    async _preparePayload(serverId) {
        const {server, settings: tunnelSettings} = await this._store.getConnection(
            serverId, this._resolverCancellation);
        if (this._destroyed)
            return;
        if (!server)
            throw new Error(_('Select an available server from the menu'));
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
                            reject(new Error(_('Failed to resolve the VPN server IPv4 address')));
                        }
                    });
            });
        }
        if (endpoint.get_family() !== Gio.SocketFamily.IPV4)
            throw new Error(_('Only IPv4 VPN server addresses are currently supported'));
        if (this._destroyed)
            return;
        const host = endpoint.to_string();
        payload.serverIpv4AddrIn = host;
        payload.serverIpv4Gateway = host;
        payload.excludedAddresses = [host];
        await applyTunnelPolicy(payload, tunnelSettings, this._resolverCancellation);
        if (this._destroyed)
            return;
        return payload;
    }

    async _reconnectAfterResume(_serverId, isCurrent) {
        if (this._destroyed || this._busy || !isCurrent() || !this._activateButton)
            return;
        this._reconnecting = true;
        this._error = '';
        this._emit();
        try {
            if (this._status.connected) {
                console.log('[AmneziaWG] resume: emitting clicked to disconnect');
                const disconnected = await this._activateButton(isCurrent);
                console.log(`[AmneziaWG] resume: disconnect click ${disconnected ? 'completed' : 'failed'}`);
                if (!disconnected)
                    return;
            }
            if (this._destroyed || !isCurrent())
                return;
            // Do not click again if another client has already reconnected.
            if (this._status.connected)
                return;
            this._waitingForUnderlay = true;
            this._emit();
            console.log('[AmneziaWG] resume: waiting for an underlying IPv4 gateway and active link');
            const ready = await this._underlayWaiter.wait(isCurrent);
            this._waitingForUnderlay = false;
            if (!ready || this._destroyed || !isCurrent() || this._busy || this._status.connected)
                return;
            console.log('[AmneziaWG] resume: underlying IPv4 gateway and link are ready');
            this._emit();
            console.log('[AmneziaWG] resume: emitting clicked to connect');
            const connected = await this._activateButton(isCurrent);
            console.log(`[AmneziaWG] resume: button operation ${connected ? 'completed' : 'failed'}`);
        } finally {
            this._waitingForUnderlay = false;
            this._reconnecting = false;
            this._emit();
        }
    }

    destroy() {
        this._destroyed = true;
        this._settings.disconnect(this._resumeSettingId);
        this._sleepMonitor?.destroy();
        this._recovery.destroy();
        this._underlayWaiter.cancel();
        this._resolverCancellation.cancel();
        this._service.destroy();
        this._activateButton = null;
        this._onUpdate = null;
    }
}
