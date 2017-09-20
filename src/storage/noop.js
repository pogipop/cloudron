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

function upload(apiConfig, backupFilePath, sourceDir, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof sourceDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('backup: %s %s', backupFilePath, sourceDir);

    callback();
}

function download(apiConfig, sourceFilePath, destination, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof sourceFilePath, 'string');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('restore: %s %s', sourceFilePath, destination);

    callback(new Error('Cannot restore from noop backend'));
}

function copy(apiConfig, oldFilePath, newFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('copy: %s -> %s', oldFilePath, newFilePath);

    callback();
}

function removeMany(apiConfig, filePaths, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert(Array.isArray(filePaths));
    assert.strictEqual(typeof callback, 'function');

    debug('removeMany: %j', filePaths);

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
