// Run from the repository root: gjs -m tests/servers.js
// Fixtures contain invented data only; this test never reads the user's config.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {parseServers} from '../serverParser.js';
import {ServerStore} from '../serverStore.js';

function assert(condition, message) {
    if (!condition)
        throw new Error(message);
}

function encode(servers) {
    const json = JSON.stringify(servers);
    return '[General]\nserversList="@ByteArray(' +
        json.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + ')"\n';
}

const fixture = [{storageServerId: 'a', description: 'Германия "1"',
    containers: [{awg: {config: 'line1\nline2\\end'}}]}];
assert(JSON.stringify(parseServers(encode(fixture))) === JSON.stringify(fixture),
    'Nested escaping and Unicode must round-trip');
assert(parseServers('serversList=@ByteArray([])\r\n').length === 0, 'Empty list');
assert(parseServers(encode([{description: 'HEXMARK'}]).replace('HEXMARK', '\\x410'))[0].description === 'А',
    'Qt hexadecimal Unicode escape');
for (const invalid of ['[General]', 'serversList=@ByteArray({})',
    'serversList=@ByteArray([null])', 'serversList=@ByteArray(["private-secret"])',
    'serversList=@ByteArray(private-secret)', 'serversList=@ByteArray(\\xZ)']) {
    let rejected = false;
    try { parseServers(invalid); } catch (error) {
        rejected = true;
        assert(!error.message.includes('private-secret'), 'Errors must not reveal source data');
    }
    assert(rejected, 'Invalid input must fail');
}

// A memory backend isolates settings from the actual desktop configuration.
const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
    GLib.build_filenamev([GLib.get_current_dir(), 'schemas']),
    Gio.SettingsSchemaSource.get_default(), false);
const settings = new Gio.Settings({
    settings_schema: schemaSource.lookup('org.gnome.shell.extensions.amneziawg', false),
    backend: Gio.memory_settings_backend_new(),
});
const directory = GLib.dir_make_tmp('amnezia-servers-test-XXXXXX');
const path = GLib.build_filenamev([directory, 'client.conf']);
const secondPath = GLib.build_filenamev([directory, 'second.conf']);
const loop = new GLib.MainLoop(null, false);
let stage = 0;
let failure = null;
let store;
const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
    failure = new Error('Timed out waiting for file monitoring');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
settings.set_string('config-path', path);
GLib.file_set_contents(path, encode(fixture));
store = new ServerStore(settings, ({servers, message}) => {
    if (message === 'Загрузка серверов…')
        return;
    try {
        if (stage === 0) {
            assert(servers.length === 1 && servers[0].id === 'a', 'Initial async load');
            assert(Object.keys(servers[0]).sort().join(',') === 'id,name', 'Only display data leaves store');
            stage = 1;
            // replace_contents saves via replacement rather than an in-place edit.
            Gio.File.new_for_path(path).replace_contents(
                new TextEncoder().encode(encode([{storageServerId: 'b', description: 'Second'}])),
                null, false, Gio.FileCreateFlags.NONE, null);
        } else if (stage === 1) {
            assert(servers[0]?.id === 'b', 'Monitor must detect atomic replacement');
            stage = 2;
            GLib.file_set_contents(secondPath, encode([]));
            settings.set_string('config-path', secondPath);
        } else if (stage === 2) {
            assert(message === 'Нет серверов', 'Path changes must reload');
            stage = 3;
            settings.set_string('config-path', secondPath + '.missing');
        } else if (stage === 3) {
            assert(message === 'Файл конфигурации не найден', 'Missing file message');
            stage = 4;
            store.reload();
            store.destroy();
            // Let cancellation callbacks run before exiting; none may reach UI.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                loop.quit();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            throw new Error('Update after destruction');
        }
    } catch (error) {
        failure = error;
        loop.quit();
    }
});
try {
    loop.run();
    if (failure)
        throw failure;
    assert(stage === 4, 'All lifecycle checks completed');
    print('PASS: parsing, privacy, asynchronous loading, atomic replacement, path changes, errors, cleanup');
} finally {
    if (stage !== 4)
        store.destroy();
    if (!failure?.message.includes('Timed out'))
        GLib.Source.remove(timeout);
    GLib.unlink(path);
    GLib.unlink(secondPath);
    GLib.rmdir(directory);
}
