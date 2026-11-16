/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ServerStore} from './serverStore.js';
import {VpnController} from './vpnController.js';

function updateIconForTheme(actor, extension, style) {
    const color = actor.get_theme_node().get_foreground_color();
    const brightness = 0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue;
    const variant = brightness > 128 ? 'dark' : 'light';
    const file = extension.dir.resolve_relative_path(`icons/${style}-${variant}.png`);
    if (!actor.gicon?.file?.equal(file))
        actor.gicon = new Gio.FileIcon({file});
}

const AmneziaToggle = GObject.registerClass(
class AmneziaToggle extends QuickMenuToggle {
    constructor(extension) {
        super({
            title: _('Amnezia'),
            gicon: new Gio.FileIcon({file: extension.dir.resolve_relative_path('icons/default-dark.png')}),
            toggleMode: false,
        });
        this.add_style_class_name('amneziawg-button');
        this.name = 'amneziawg-toggle';

        const updateIcon = () => updateIconForTheme(this, extension, 'default');
        this.connect('style-changed', updateIcon);

        const scrollView = new St.ScrollView({
            style: 'max-height: 240px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });

        const serversSection = new PopupMenu.PopupMenuSection();

        scrollView.set_child(serversSection.actor);
        this.menu.box.add_child(scrollView);

        const settings = extension.getSettings();
        let currentServers = [];
        let controller = null;
        let vpnState = {available: false, connected: false, busy: false, message: 'Проверка VPN…'};
        const statusItem = new PopupMenu.PopupMenuItem('Проверка VPN…', {reactive: false});
        this.menu.addMenuItem(statusItem, 0);
        const updateSelection = () => {

            const selected = settings.get_string('selected-server-id');
            const selectedName = currentServers.find(server => server.id === selected)?.name;

            this.checked = vpnState.connected;
            this.subtitle = vpnState.message || (vpnState.connected
                ? vpnState.activeServerName ?? 'VPN подключён' : selectedName ?? 'Выберите сервер');
            
            statusItem.label.text = vpnState.message || (vpnState.connected
                ? `Подключено: ${vpnState.activeServerName ?? 'сервер не определён'}` : 'VPN отключён');
            
            
            for (const item of serversSection._getMenuItems()) {
                item.setOrnament(item._serverId === selected
                    ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            }
        };
        const store = new ServerStore(settings, ({servers, message}) => {
            if (message !== 'Загрузка серверов…')
                currentServers = servers;
            serversSection.removeAll();
            if (message) {
                serversSection.addMenuItem(new PopupMenu.PopupMenuItem(message, {reactive: false}));
            } else {
                for (const server of servers) {
                    const item = serversSection.addAction(server.name, () => {
                        settings.set_string('selected-server-id', server.id);
                    });

                    const address = new St.Label({
                        text: server.hostName ? ` (${server.hostName})` : '',
                        style_class: 'server-address',
                        x_expand: true,
                        x_align: Clutter.ActorAlign.END,
                        y_align: Clutter.ActorAlign.CENTER,
                    });

                    item._serverId = server.id;
                    item.add_child(address);
                }
            }

            if (servers.length && !settings.get_string('selected-server-id'))
                settings.set_string('selected-server-id', servers.at(-1).id);

            controller?.setServers(currentServers);
            updateSelection();
        });
        controller = new VpnController(settings, store, state => {
            vpnState = state;
            updateSelection();
        });
        updateSelection();
        const selectionChangedId = settings.connect('changed::selected-server-id', updateSelection);
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                store.reload();
        });
        this.connect('destroy', () => {
            controller.destroy();
            store.destroy();
            settings.disconnect(selectionChangedId);
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Настройки', () => {
            Main.panel.statusArea.quickSettings.menu.close();
            extension.openPreferences();
        });

        this.connect('clicked', () => controller.toggle());
    }
});

const AmneziaIndicator = GObject.registerClass(
class AmneziaIndicator extends SystemIndicator {
    constructor(extension) {
        super();

        this._indicator = this._addIndicator();
        const settings = extension.getSettings();

        this._indicator.gicon = new Gio.FileIcon({file: extension.dir.resolve_relative_path(
            `icons/${settings.get_string('icon-style')}-dark.png`)
        });

        const updatePanelIcon = () => updateIconForTheme(
            this._indicator, extension, settings.get_string('icon-style'));

        const iconChangedId = settings.connect('changed::icon-style', updatePanelIcon);
        this._indicator.connect('style-changed', updatePanelIcon);
        this.connect('destroy', () => settings.disconnect(iconChangedId));

        const toggle = new AmneziaToggle(extension);
        toggle.bind_property('checked',
            this._indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);

        this.quickSettingsItems.push(toggle);
    }
});

export default class AmneziaExtension extends Extension {
    enable() {
        this._indicator = new AmneziaIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
    }
}
