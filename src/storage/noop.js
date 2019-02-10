'use strict';

exports = module.exports = {
    upload: upload,
    download: download,
    downloadDir: downloadDir,
    copy: copy,

    listDir: listDir,

    remove: remove,
    removeDir: removeDir,

    testConfig: testConfig,
    removePrivateFields: removePrivateFields,
    injectPrivateFields: injectPrivateFields
};

var assert = require('assert'),
    debug = require('debug')('box:storage/noop'),
    EventEmitter = require('events');

function upload(apiConfig, backupFilePath, sourceStream, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof sourceStream, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('upload: %s', backupFilePath);

    callback(null);
}

function download(apiConfig, backupFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('download: %s', backupFilePath);

    callback(new Error('Cannot download from noop backend'));
}

function listDir(apiConfig, dir, batchSize, iteratorCallback, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof dir, 'string');
    assert.strictEqual(typeof batchSize, 'number');
    assert.strictEqual(typeof iteratorCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    callback();
}

function downloadDir(apiConfig, backupFilePath, destDir) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof destDir, 'string');

    var events = new EventEmitter();
    process.nextTick(function () {
        debug('downloadDir: %s -> %s', backupFilePath, destDir);

        events.emit('done', new Error('Cannot download from noop backend'));
    });
    return events;
}

function copy(apiConfig, oldFilePath, newFilePath) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');

    debug('copy: %s -> %s', oldFilePath, newFilePath);

    var events = new EventEmitter();
    process.nextTick(function () { events.emit('done', null); });
    return events;
}

function remove(apiConfig, filename, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof filename, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('remove: %s', filename);

    callback(null);
}

function removeDir(apiConfig, pathPrefix) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');

    debug('removeDir: %s', pathPrefix);

    var events = new EventEmitter();
    process.nextTick(function () { events.emit('done', null); });
    return events;
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    callback(null);
}

function removePrivateFields(apiConfig) {
    return apiConfig;
}

function injectPrivateFields(newConfig, currentConfig) {
}
