'use strict';

// -------------------------------------------
//  This file just describes the interface
//
//  New backends can start from here
// -------------------------------------------

exports = module.exports = {
    backupBegin: backupBegin,
    backupDirectory: backupDirectory,
    backupFinalize: backupFinalize,

    getRestoreUrl: getRestoreUrl,
    getAppRestoreConfig: getAppRestoreConfig,
    getLocalFilePath: getLocalFilePath,

    copyObject: copyObject,
    removeBackup: removeBackup,

    backupDone: backupDone,

    testConfig: testConfig
};

var assert = require('assert');

function backupBegin(apiConfig, backupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function backupDirectory(apiConfig, backupId, source, destination, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof source, 'string');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function backupFinalize(apiConfig, backupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function getRestoreUrl(apiConfig, filename, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof filename, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: { url: <restoreUrl>, sha1: <optional> }
    // The resulting url must work with curl as it is passed into start.sh and restoreapp.sh

    callback(new Error('not implemented'));
}

function getAppRestoreConfig(apiConfig, backupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    // var configFilename = backupId.replace(/\.tar\.gz$/, '.json');

    // Result: {} <- Backup config object from .json file
    // The resulting url must work with curl as it is passed into start.sh and restoreapp.sh

    callback(new Error('not implemented'));
}

function getLocalFilePath(apiConfig, filename, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof filename, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: { filePath: <localFilePath> }
    // The resulting filePath is a local path to the backup file

    callback(new Error('not implemented'));
}

function copyObject(apiConfig, from, to, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof from, 'string');
    assert.strictEqual(typeof to, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function removeBackup(apiConfig, backupId, appBackupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function backupDone(filename, app, appBackupIds, callback) {
    assert.strictEqual(typeof filename, 'string');
    assert(!app || typeof app === 'object');
    assert(!appBackupIds || Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback(new Error('not implemented'));
}
