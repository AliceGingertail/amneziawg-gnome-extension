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
        this.add_style_class_name('amneziawg-button');
        this.name = 'amneziawg-toggle';
        const updateIcon = () => {
            // Use the actual Shell theme foreground, including custom themes
            // and the button's checked state, to select a contrasting icon.
            const color = this.get_theme_node().get_foreground_color();
            const brightness = 0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue;
            const variant = brightness > 128 ? 'dark' : 'light';
            const file = extension.dir.resolve_relative_path(`icons/default-${variant}.png`);
            if (!this.gicon?.file?.equal(file))
                this.gicon = new Gio.FileIcon({file});
        };
        this.connect('style-changed', updateIcon);

        const scrollView = new St.ScrollView({
            style: 'max-height: 240px;',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });

        // Контейнер для пунктов списка
        const serversSection = new PopupMenu.PopupMenuSection();

        scrollView.set_child(serversSection.actor);
        this.menu.box.add_child(scrollView);


        for (let i = 0; i < 10; i++) {
            const serverName = `Германия ${i}`;
            // Пункты меню и действия при их выборе
            serversSection.addAction(serverName, () => {
                this.subtitle = serverName;
                console.log('Выбран сервер Германии');
            });
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Настройки', () => {
            Main.panel.statusArea.quickSettings.menu.close();
            extension.openPreferences();
        });
            
        // Нажатие на основную часть кнопки
        this.connect('clicked', () => {
            console.log('Состояние кнопки:', this.checked);
        });
        
        this.connect('clicked', () => {
            console.log('Клик! Включено:', this.checked);

            if (this.checked) {
                // Подключить VPN
            } else {
                    // Отключить VPN
            }
        });
    }
});

const ExampleIndicator = GObject.registerClass(
class ExampleIndicator extends SystemIndicator {
    constructor(extension) {
        super();

        this._indicator = this._addIndicator();
        const settings = extension.getSettings();
        // Set an icon before the actor receives its first style notification.
        this._indicator.gicon = new Gio.FileIcon({file: extension.dir.resolve_relative_path(
            `icons/${settings.get_string('icon-style')}-dark.png`)});
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
        const iconChangedId = settings.connect('changed::icon-style', updatePanelIcon);
        this._indicator.connect('style-changed', updatePanelIcon);
        this.connect('destroy', () => settings.disconnect(iconChangedId));
        
        const toggle = new ExampleToggle(extension);
        toggle.bind_property('checked',
            this._indicator, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
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
