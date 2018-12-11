'use strict';

require('supererror')({ splatchError: true });

var assert = require('assert'),
    backups = require('./backups.js'),
    database = require('./database.js'),
    debug = require('debug')('box:taskworker'),
    reverseProxy = require('./reverseproxy.js'),
    tasks = require('./tasks.js'),
    updater = require('./updater.js');

const NOOP_CALLBACK = function (error) { if (error) debug(error); };

const TASKS = { // indexed by task type
    backup: backups.backupBoxAndApps,
    update: updater.update,
    renewcerts: reverseProxy.renewCerts,

    _identity: (arg, progressCallback, callback) => callback(null, arg),
    _error: (arg, progressCallback, callback) => callback(new Error(`Failed for arg: ${arg}`)),
    _crash: (arg) => { throw new Error(`Crashing for arg: ${arg}`); },
    _sleep: (arg) => setTimeout(process.exit, arg)
};

process.on('SIGTERM', function () {
    process.exit(0);
});

assert.strictEqual(process.argv.length, 3, 'Pass the taskid as argument');
const taskId = process.argv[2];

// Main process starts here
debug(`Staring task ${taskId}`);

database.initialize(function (error) {
    if (error) return process.exit(50);

    tasks.get(taskId, function (error, task) {
        if (error) return process.exit(50);

        const progressCallback = (progress) => tasks.update(taskId, progress, NOOP_CALLBACK);
        const resultCallback = (error, result) => {
            const progress = { percent: 100, result: result || null, errorMessage: error ? error.message : null };

            tasks.update(taskId, progress, () => process.exit(error ? 50 : 0));
        };

        TASKS[task.type].apply(null, task.args.concat(progressCallback).concat(resultCallback));
    });
});
