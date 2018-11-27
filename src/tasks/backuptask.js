#!/bin/bash
':' //# comment; exec /usr/bin/env node --max_old_space_size=300 "$0" "$@"

// to understand the above hack read http://sambal.org/2014/02/passing-options-node-shebang-line/

'use strict';

require('supererror')({ splatchError: true });

var assert = require('assert'),
    backups = require('../backups.js'),
    database = require('../database.js'),
    debug = require('debug')('box:backuptask'),
    tasks = require('../tasks.js');

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.initialize(callback);
}

// Main process starts here
const NOOP_CALLBACK = function (error) { if (error) debug(error); };
const auditSource = JSON.parse(process.argv[2]);

debug('Staring complete backup');

process.on('SIGTERM', function () {
    process.exit(0);
});

initialize(function (error) {
    if (error) throw error;

    backups.backupBoxAndApps(auditSource, (progress) => tasks.setProgress(tasks.TASK_BACKUP, progress, NOOP_CALLBACK), function (error) {
        if (error) debug('backup failed.', error);

        process.send({ result: error ? error.message : '' });

        // https://nodejs.org/api/process.html are exit codes used by node. apps.js uses the value below
        // to check apptask crashes
        process.exit(error ? 50 : 0);
    });
});
