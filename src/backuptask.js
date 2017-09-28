#!/bin/bash
':' //# comment; exec /usr/bin/env node --max_old_space_size=300 "$0" "$@"

// to understand the above hack read http://sambal.org/2014/02/passing-options-node-shebang-line/

'use strict';

if (process.argv[2] === '--check') return console.log('OK');

require('supererror')({ splatchError: true });

// remove timestamp from debug() based output
require('debug').formatArgs = function formatArgs(args) {
    args[0] = this.namespace + ' ' + args[0];
};

var assert = require('assert'),
    backups = require('./backups.js'),
    database = require('./database.js'),
    debug = require('debug')('box:backuptask'),
    paths = require('./paths.js'),
    safe = require('safetydance');

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.initialize(callback);
}

// Main process starts here
var backupId = process.argv[2];
var format = process.argv[3];
var dataDir = process.argv[4];

debug(`Backing up ${dataDir} to ${backupId}`);

process.on('SIGTERM', function () {
    process.exit(0);
});

initialize(function (error) {
    if (error) throw error;

    safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, '');

    backups.upload(backupId, format, dataDir, function resultHandler(error) {
        if (error) debug('completed with error', error);

        debug('completed');

        safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, error ? error.message : '');

        // https://nodejs.org/api/process.html are exit codes used by node. apps.js uses the value below
        // to check apptask crashes
        process.exit(error ? 50 : 0);
    });
});
