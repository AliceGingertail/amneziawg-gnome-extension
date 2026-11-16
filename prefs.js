import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class AmneziaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window._settings = settings;
        const page = new Adw.PreferencesPage({title: 'AmneziaVPN', icon_name: 'network-vpn-symbolic'});
        window.add(page);

        const connection = new Adw.PreferencesGroup({title: 'Подключение'});
        page.add(connection);
        const path = new Adw.EntryRow({title: 'Путь к AmneziaVPN.conf'});

        settings.bind('config-path', path, 'text', Gio.SettingsBindFlags.DEFAULT);
        connection.add(path);

        const status = new Adw.ActionRow();
        connection.add(status);
        const validatePath = () => {

            const value = path.text;
            const expanded = value.startsWith('~/')
                ? GLib.build_filenamev([GLib.get_home_dir(), value.slice(2)]) : value;

            const valid = GLib.path_is_absolute(expanded) &&
                GLib.file_test(expanded, GLib.FileTest.IS_REGULAR) &&
                Gio.File.new_for_path(expanded).query_info(
                    'access::can-read', Gio.FileQueryInfoFlags.NONE, null
                ).get_attribute_boolean('access::can-read');

            status.title = valid ? 'Файл конфигурации доступен' : 'Файл не найден или недоступен для чтения';
            path[valid ? 'remove_css_class' : 'add_css_class']('error');

        };

        path.connect('notify::text', () => {
            try { validatePath(); } catch { status.title = 'Не удалось проверить файл конфигурации'; }
        });
        try { validatePath(); } catch { status.title = 'Не удалось проверить файл конфигурации'; }

        const browse = new Gtk.Button({icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Выбрать файл конфигурации'});
        path.add_suffix(browse);
        browse.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Выбрать AmneziaVPN.conf'});

            dialog.open(window, null, (source, result) => {
                try {
                    const selected = source.open_finish(result).get_path();

                    if (selected)
                        settings.set_string('config-path', selected);
                } catch (error) {

                    if (!error.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                        window.add_toast(new Adw.Toast({title: 'Не удалось выбрать файл'}));
                }
            });
        });

        const interfaces = new Adw.ComboRow({title: 'Сетевой интерфейс',
            subtitle: 'Интерфейс для отслеживания состояния VPN'});
        connection.add(interfaces);

        let names = [];
        let refreshing = false;
        const reloadInterfaces = () => {
            refreshing = true;
            names = [];
            try {
                const enumerator = Gio.File.new_for_path('/sys/class/net').enumerate_children(
                    'standard::name', Gio.FileQueryInfoFlags.NONE, null);
                try {
                    let info;
                    while ((info = enumerator.next_file(null)))
                        names.push(info.get_name());
                } finally {
                    enumerator.close(null);
                }
            } catch (error) {
                console.warn(`Не удалось получить сетевые интерфейсы: ${error.message}`);
            }
            names.sort();
            const saved = settings.get_string('network-interface');
            if (saved && !names.includes(saved))
                names.push(saved);
            names.unshift('');
            interfaces.model = Gtk.StringList.new(names.map(name => name || 'Автоматически'));
            interfaces.selected = names.indexOf(saved);
            refreshing = false;
        };
        reloadInterfaces();
        interfaces.connect('notify::selected', () => {
            if (!refreshing && names[interfaces.selected] !== undefined)
                settings.set_string('network-interface', names[interfaces.selected]);
        });
        const refresh = new Gtk.Button({icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER, tooltip_text: 'Обновить список интерфейсов'});
        interfaces.add_suffix(refresh);
        refresh.connect('clicked', reloadInterfaces);

        const appearance = new Adw.PreferencesGroup({title: 'Внешний вид',
            description: 'Светлый или тёмный вариант иконок выбирается автоматически по теме Shell.'});
        page.add(appearance);
        const styles = ['default', 'color'];
        const icon = new Adw.ComboRow({title: 'Иконка в верхней панели',
            model: Gtk.StringList.new(['Обычная', 'Цветная']),
            selected: styles.indexOf(settings.get_string('icon-style'))});
        appearance.add(icon);
        const preview = new Gtk.Image({pixel_size: 32});
        icon.add_prefix(preview);

        const updatePreview = () => {
            const variant = Adw.StyleManager.get_default().dark ? 'dark' : 'light';
            preview.set_from_file(this.dir.resolve_relative_path(
                `icons/${settings.get_string('icon-style')}-${variant}.png`).get_path());
        };
        icon.connect('notify::selected', () => {
            settings.set_string('icon-style', styles[icon.selected]);
            updatePreview();
        });

        const styleManager = Adw.StyleManager.get_default();
        const themeChangedId = styleManager.connect('notify::dark', updatePreview);
        window.connect('close-request', () => {
            styleManager.disconnect(themeChangedId);
            return false;
        });
        updatePreview();
    }
}
