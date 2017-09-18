'use strict';

exports = module.exports = {
    upload: upload,
    download: download,
    copy: copy,

    removeMany: removeMany,

    backupDone: backupDone,

    testConfig: testConfig
};

var assert = require('assert'),
    debug = require('debug')('box:storage/noop');

function upload(apiConfig, backupId, sourceDir, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof sourceDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('backup: %s %s', backupId, sourceDir);

    callback();
}

function download(apiConfig, backupId, destination, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('restore: %s %s', backupId, destination);

    callback(new Error('Cannot restore from noop backend'));
}

function copy(apiConfig, oldBackupId, newBackupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldBackupId, 'string');
    assert.strictEqual(typeof newBackupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('copyBackup: %s -> %s', oldBackupId, newBackupId);

    callback();
}

function removeMany(apiConfig, backupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert(Array.isArray(backupIds));
    assert.strictEqual(typeof callback, 'function');

    debug('removeMany: %j', backupIds);

    callback();
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    callback();
}

function backupDone(backupId, appBackupIds, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback();
}
