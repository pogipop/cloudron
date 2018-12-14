#!/bin/bash
':' //# comment; exec /usr/bin/env node --max_old_space_size=300 "$0" "$@"

// to understand the above hack read http://sambal.org/2014/02/passing-options-node-shebang-line/

'use strict';

if (process.argv[2] === '--check') return console.log('OK');

require('supererror')({ splatchError: true });

var assert = require('assert'),
    backups = require('../backups.js'),
    database = require('../database.js'),
    debug = require('debug')('box:backupupload');

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

// this can happen when the backup task is terminated (not box code)
process.on('disconnect', function () {
    debug('parent process died');
    process.exit(0);
});

initialize(function (error) {
    if (error) throw error;

    backups.upload(backupId, format, dataDir, (progress) => process.send(progress), function resultHandler(error) {
        if (error) debug('upload completed with error', error);

        debug('upload completed');

        process.send({ result: error ? error.message : '' });

        // https://nodejs.org/api/process.html are exit codes used by node. apps.js uses the value below
        // to check apptask crashes
        process.exit(error ? 50 : 0);
    });
});