'use strict';

require('supererror')({ splatchError: true });

var assert = require('assert'),
    backups = require('../backups.js'),
    database = require('../database.js'),
    debug = require('debug')('box:backuptask'),
    tasks = require('../tasks.js');

const NOOP_CALLBACK = function (error) { if (error) debug(error); };

process.on('SIGTERM', function () {
    process.exit(0);
});

assert.strictEqual(process.argv.length, 3, 'Pass the taskid as argument');
const taskId = process.argv[2];

// Main process starts here
debug('Staring backup');
database.initialize(function (error) {
    if (error) return process.exit(50);

    backups.backupBoxAndApps((progress) => tasks.update(taskId, progress, NOOP_CALLBACK), function (error, backupId) {
        const progress = { percent: 100, result: backupId || '', errorMessage: error ? error.message : '' };

        tasks.update(taskId, progress, () => process.exit(error ? 50 : 0));
    });
});
