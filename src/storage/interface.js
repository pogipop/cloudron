'use strict';

// -------------------------------------------
//  This file just describes the interface
//
//  New backends can start from here
// -------------------------------------------

exports = module.exports = {
    backup: backup,
    restore: restore,
    copyBackup: copyBackup,
    removeBackup: removeBackup,

    getDownloadStream: getDownloadStream,

    backupDone: backupDone,

    testConfig: testConfig
};

var assert = require('assert');

function backup(apiConfig, backupId, sourceDirectories, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(sourceDirectories));
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function restore(apiConfig, backupId, destination, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function copyBackup(apiConfig, oldBackupId, newBackupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldBackupId, 'string');
    assert.strictEqual(typeof newBackupId, 'string');
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

function getDownloadStream(apiConfig, backupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: ReadStream to a tar.gz (not encrypted)

    callback(new Error('not implemented'));
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    // Result: none - first callback argument error if config does not pass the test

    callback(new Error('not implemented'));
}

function backupDone(filename, app, appBackupIds, callback) {
    assert.strictEqual(typeof filename, 'string');
    assert(!app || typeof app === 'object');
    assert(!appBackupIds || Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback(new Error('not implemented'));
}
