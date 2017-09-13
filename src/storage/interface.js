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
    removeBackups: removeBackups,

    backupDone: backupDone,

    testConfig: testConfig
};

var assert = require('assert');

function backup(apiConfig, backupId, sourceDir, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof sourceDir, 'string');
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

function removeBackups(apiConfig, backupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert(Array.isArray(backupIds));
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    // Result: none - first callback argument error if config does not pass the test

    callback(new Error('not implemented'));
}

function backupDone(backupId, appBackupIds, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback(new Error('not implemented'));
}
