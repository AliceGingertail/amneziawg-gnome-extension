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

import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ServerStore} from './serverStore.js';

const ExampleToggle = GObject.registerClass(
class ExampleToggle extends QuickMenuToggle {
    constructor(extension) {
        super({
            title: _('Amnezia'),
            gicon: new Gio.FileIcon({
            file: extension.dir.resolve_relative_path(
                'icons/default-dark.png'
            ),
            }),
            toggleMode: true,
        });    
        // A CSS class can style multiple actors a name can target this actor.
        this.add_style_class_name('amneziawg-button');
        this.name = 'amneziawg-toggle';

        const updateIcon = () => {
            const color = this.get_theme_node().get_foreground_color();
            // Weighted RGB brightness approximates how bright the text looks
            // The files are named for the BACKGROUND: default-dark.png contains
            // a pale logo for dark backgrounds, default-light.png a dark logo
            const brightness = 0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue;
            const variant = brightness > 128 ? 'dark' : 'light';
            const file = extension.dir.resolve_relative_path(`icons/default-${variant}.png`);

            // changed icon avoids unnecessary work and repeated style updates.
            if (!this.gicon?.file?.equal(file))
                this.gicon = new Gio.FileIcon({file});
        };
        // Signals gnome events
        this.connect('style-changed', updateIcon);

        // Constrain the server list so a long list does not fill the screen.
        // These constructor options use the native widgets property names.
        const scrollView = new St.ScrollView({
            style: 'max-height: 240px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });

        // A menu section manages clickable items its actor is the visual part
        // placed inside the scrolling container, then inside the toggles menu
        const serversSection = new PopupMenu.PopupMenuSection();

        scrollView.set_child(serversSection.actor);
        this.menu.box.add_child(scrollView);


        const settings = extension.getSettings();
        let currentServers = [];
        const updateSelection = () => {
            const selected = settings.get_string('selected-server-id');
            this.subtitle = currentServers.find(server => server.id === selected)?.name ?? null;
            // A dot marks the saved selection. Saving an ID instead of an index
            // keeps the selection when the client changes the order of servers.
            for (const item of serversSection._getMenuItems()) {
                item.setOrnament(item._serverId === selected
                    ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            }
        };
        const store = new ServerStore(settings, ({servers, message}) => {
            currentServers = servers;
            serversSection.removeAll();
            if (message) {
                serversSection.addMenuItem(new PopupMenu.PopupMenuItem(message, {reactive: false}));
            } else {
                for (const server of servers) {
                    const item = serversSection.addAction(server.name, () => {
                        settings.set_string('selected-server-id', server.id);
                    });
                    item._serverId = server.id;
                }
            }
            updateSelection();
        });
        const selectionChangedId = settings.connect('changed::selected-server-id', updateSelection);
        // A manual reopen retries loading if the file was missing at startup.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                store.reload();
        });
        this.connect('destroy', () => {
            store.destroy();
            settings.disconnect(selectionChangedId);
        });

        // Keep preferences outside the scrolling list so they remain accessible
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Настройки', () => {
            Main.panel.statusArea.quickSettings.menu.close();
            extension.openPreferences();
        });
            
        this.connect('clicked', () => {
            console.log('Состояние кнопки:', this.checked);
        });
        
        this.connect('clicked', () => {
            console.log('Клик! Включено:', this.checked);

            if (this.checked) {
                // TODO: request a real VPN connection here.
            } else {
                    // TODO: request a real VPN disconnection here.
            }
        });
    }
});

const ExampleIndicator = GObject.registerClass(
class ExampleIndicator extends SystemIndicator {
    constructor(extension) {
        super();

        this._indicator = this._addIndicator();
        // getSettings loads the schema named by metadata.json. The preferences
        const settings = extension.getSettings();

        // Set an icon before the actor receives its first style notification.
        this._indicator.gicon = new Gio.FileIcon({file: extension.dir.resolve_relative_path(
            `icons/${settings.get_string('icon-style')}-dark.png`)
        });
        
        // The panel and menu can have different background colors. Measure this
        // icon own foreground rather than copying the menu button's icon
        const updatePanelIcon = () => {
            const style = settings.get_string('icon-style');
            const type = style;
            const color = this._indicator.get_theme_node().get_foreground_color();
            const brightness = 0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue;
            const variant = brightness > 128 ? 'dark' : 'light';
            const file = extension.dir.resolve_relative_path(`icons/${type}-${variant}.png`);
            if (!this._indicator.gicon?.file?.equal(file))
                this._indicator.gicon = new Gio.FileIcon({file});
        };

        // changed::icon-style listens to only this settings key. connect returns
        // an ID needed to disconnect later: settings can outlive this actor.
        const iconChangedId = settings.connect('changed::icon-style', updatePanelIcon);
        this._indicator.connect('style-changed', updatePanelIcon);
        this.connect('destroy', () => settings.disconnect(iconChangedId));
        
        const toggle = new ExampleToggle(extension);
        // A one-way binding copies checked -> visible whenever checked changes.
        // SYNC_CREATE also copies the current value immediately. Consequently,
        // the panel icon is hidden while the demo toggle is off.
        toggle.bind_property('checked',
            this._indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        
        // Register the button as one of this indicator's Quick Settings items.
        this.quickSettingsItems.push(toggle);
    }
});

export default class QuickSettingsExampleExtension extends Extension {
    enable() {
        this._indicator = new ExampleIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
    }
}
