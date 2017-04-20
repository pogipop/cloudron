#!/usr/bin/env node

'use strict';

require('supererror')({ splatchError: true });

// remove timestamp from debug() based output
require('debug').formatArgs = function formatArgs(args) {
    args[0] = this.namespace + ' ' + args[0];
};

var assert = require('assert'),
    database = require('./database.js'),
    debug = require('debug')('box:backuptask'),
    path = require('path'),
    paths = require('./paths.js'),
    filesystem = require('./storage/filesystem.js'),
    caas = require('./storage/caas.js'),
    s3 = require('./storage/s3.js'),
    BackupsError = require('./backups.js').BackupsError,
    settings = require('./settings.js');

function api(provider) {
    switch (provider) {
        case 'caas': return caas;
        case 's3': return s3;
        case 'filesystem': return filesystem;
        default: return null;
    }
}

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.initialize(callback);
}

function restoreApp(backupId, appId, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('Start app restore with id %s for %s', backupId, appId);

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        api(backupConfig.provider).restore(backupConfig, backupId, path.join(paths.APPS_DATA_DIR, appId), callback);
    });
}

// Main process starts here
var backupId = process.argv[2];
var appId = process.argv[3];

if (!backupId || !appId) {
    console.error('Usage: restoreapptask.js <backupId> <appId>');
    process.exit(1);
}

debug('Apprestoretask for the app %s with id %s', appId, backupId);

process.on('SIGTERM', function () {
    process.exit(0);
});

initialize(function (error) {
    if (error) throw error;

    function resultHandler(error) {
        if (error) debug('Apprestoretask completed with error', error);

        debug('Apprestoretask completed');

        // https://nodejs.org/api/process.html are exit codes used by node. apps.js uses the value below
        // to check apptask crashes
        process.exit(error ? 50 : 0);
    }

    restoreApp(backupId, appId, resultHandler);
});
