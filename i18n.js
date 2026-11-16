import Gettext from 'gettext';
import Gio from 'gi://Gio';

// Shared by Shell, preferences, and standalone diagnostics without Shell imports.
const domain = 'amneziawg';
const localeDir = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('locale').get_path();
Gettext.bindtextdomain(domain, localeDir);

export function gettext(message) {
    return Gettext.dgettext(domain, message);
}

export function format(message, ...values) {
    let index = 0;
    return message.replace(/%s/g, () => String(values[index++]));
}
