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

const NOOP_CALLBACK = function (error) { if (error) debug(error); };

process.on('SIGTERM', function () {
    process.exit(0);
});

// Main process starts here
debug('Staring backup');
database.initialize(function (error) {
    if (error) return process.exit(50);

    backups.backupBoxAndApps((progress) => tasks.setProgress(tasks.TASK_BACKUP, progress, NOOP_CALLBACK), function (error, backupId) {
        const progress = { percent: 100, result: backupId || '', errorMessage: error ? error.message : '' };

        tasks.setProgress(tasks.TASK_BACKUP, progress, () => process.exit(error ? 50 : 0));
    });
});
