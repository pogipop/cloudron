#!/bin/bash
':' //# comment; exec /usr/bin/env node --max_old_space_size=300 "$0" "$@"

// to understand the above hack read http://sambal.org/2014/02/passing-options-node-shebang-line/

'use strict';

require('supererror')({ splatchError: true });

var assert = require('assert'),
    backups = require('../backups.js'),
    database = require('../database.js'),
    debug = require('debug')('box:backuptask'),
    paths = require('../paths.js'),
    safe = require('safetydance');

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.initialize(callback);
}

// Main process starts here
const auditSource = JSON.parse(process.argv[2]);

debug('Staring complete backup');

process.on('SIGTERM', function () {
    process.exit(0);
});

initialize(function (error) {
    if (error) throw error;

    safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, '');

    backups.backupBoxAndApps(auditSource, function (error) {
        if (error) debug('backup failed.', error);

        safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, error ? error.message : '');

        // https://nodejs.org/api/process.html are exit codes used by node. apps.js uses the value below
        // to check apptask crashes
        process.exit(error ? 50 : 0);
    });
});
