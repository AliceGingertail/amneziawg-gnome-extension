import GLib from 'gi://GLib';
import System from 'system';
import {getServiceStatus} from '../amneziaService.js';

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
getServiceStatus({socketPath: ARGV[0] ?? null})
    .then(status => print(JSON.stringify(status, null, 2)))
    .catch(error => {
        printerr(error.message);
        exitCode = 1;
    })
    .finally(() => loop.quit());
loop.run();
System.exit(exitCode);
