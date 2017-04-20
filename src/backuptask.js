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

function backupApp(backupId, appId, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('Start app backup with id %s for %s', backupId, appId);

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var backupMapping = [{
            source: path.join(paths.APPS_DATA_DIR, appId),
            destination: '.'
        }];

        api(backupConfig.provider).backup(backupConfig, backupId, backupMapping, callback);
    });
}

function backupBox(backupId, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('Start box backup with id %s', backupId);

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var backupMapping = [{
            source: paths.BOX_DATA_DIR,
            destination: 'box'
        }, {
            source: path.join(paths.PLATFORM_DATA_DIR, 'mail'),
            destination: 'mail'
        }];

        api(backupConfig.provider).backup(backupConfig, backupId, backupMapping, callback);
    });
}

// Main process starts here
var backupId = process.argv[2];
var appId = process.argv[3];

if (appId) debug('Backuptask for the app %s with id %s', appId, backupId);
else debug('Backuptask for the whole Cloudron with id %s', backupId);

process.on('SIGTERM', function () {
    process.exit(0);
});

initialize(function (error) {
    if (error) throw error;

    function resultHandler(error) {
        if (error) debug('Backuptask completed with error', error);

        debug('Backuptask completed');

        // https://nodejs.org/api/process.html are exit codes used by node. apps.js uses the value below
        // to check apptask crashes
        process.exit(error ? 50 : 0);
    }

    if (appId) backupApp(backupId, appId, resultHandler);
    else backupBox(backupId, resultHandler);
});
