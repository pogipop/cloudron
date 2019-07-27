#!/bin/bash
':' //# comment; exec /usr/bin/env node --expose-gc "$0" "$@"

// to understand the above hack read http://sambal.org/2014/02/passing-options-node-shebang-line/

'use strict';

if (process.argv[2] === '--check') return console.log('OK');

require('supererror')({ splatchError: true });

var assert = require('assert'),
    async = require('async'),
    backups = require('../backups.js'),
    database = require('../database.js'),
    debug = require('debug')('box:backupupload'),
    settings = require('../settings.js');

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    async.series([
        database.initialize,
        settings.initCache
    ], callback);
}

// Main process starts here
const backupId = process.argv[2];
const format = process.argv[3];
const dataLayoutString = process.argv[4];

debug(`Backing up ${dataLayoutString} to ${backupId}`);

process.on('SIGTERM', function () {
    process.exit(0);
});

// this can happen when the backup task is terminated (not box code)
process.on('disconnect', function () {
    debug('parent process died');
    process.exit(0);
});

// send progress every n seconds
function throttledProgressCallback(msecs) {
    let lastProgress = null;

    return function (progress) {
        let now = Date.now();
        if (lastProgress && ((now - lastProgress) < msecs)) return;
        process.send(progress);
        lastProgress = now;
    };
}

initialize(function (error) {
    if (error) throw error;

    backups.upload(backupId, format, dataLayoutString, throttledProgressCallback(5000), function resultHandler(error) {
        if (error) debug('upload completed with error', error);

        debug('upload completed');

        process.send({ result: error ? error.message : '' });

        // https://nodejs.org/api/process.html are exit codes used by node. apps.js uses the value below
        // to check apptask crashes
        process.exit(error ? 50 : 0);
    });
});
