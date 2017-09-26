'use strict';

exports = module.exports = {
    upload: upload,
    download: download,
    downloadDir: downloadDir,
    copy: copy,

    remove: remove,

    backupDone: backupDone,

    testConfig: testConfig
};

var assert = require('assert'),
    debug = require('debug')('box:storage/noop');

function upload(apiConfig, backupFilePath, sourceStream, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof sourceStream, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('upload: %s', backupFilePath);

    callback();
}

function download(apiConfig, backupFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('download: %s', backupFilePath);

    callback(new Error('Cannot download from noop backend'));
}

function downloadDir(apiConfig, backupFilePath, destDir, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof destDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('downloadDir: %s -> %s', backupFilePath, destDir);

    callback();
}

function copy(apiConfig, oldFilePath, newFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('copy: %s -> %s', oldFilePath, newFilePath);

    callback();
}

function remove(apiConfig, pathPrefix, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('remove: %s', pathPrefix);

    callback();
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    callback();
}

function backupDone(apiConfig, backupId, appBackupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback();
}
