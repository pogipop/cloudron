'use strict';

// -------------------------------------------
//  This file just describes the interface
//
//  New backends can start from here
// -------------------------------------------

// Implementation note:
//     retry logic for upload() comes from the syncer since it is stream based
//     for the other API calls we leave it to the backend to retry. this allows
//     them to tune the concurrency based on failures/rate limits accordingly
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
    EventEmitter = require('events');

function removePrivateFields(apiConfig) {
    // in-place removal of tokens and api keys with domains.SECRET_PLACEHOLDER
    return apiConfig;
}

function injectPrivateFields(newConfig, currentConfig) {
    // in-place injection of tokens and api keys which came in with domains.SECRET_PLACEHOLDER
}

function upload(apiConfig, backupFilePath, sourceStream, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof sourceStream, 'object');
    assert.strictEqual(typeof callback, 'function');

    // Result: none
    // sourceStream errors are handled upstream

    callback(new Error('not implemented'));
}

function download(apiConfig, backupFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: download stream
    callback(new Error('not implemented'));
}

function downloadDir(apiConfig, backupFilePath, destDir) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof destDir, 'string');

    var events = new EventEmitter();
    process.nextTick(function () { events.emit('done', null); });
    return events;
}

function copy(apiConfig, oldFilePath, newFilePath) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');

    var events = new EventEmitter();
    process.nextTick(function () { events.emit('done', null); });
    return events;
}

function listDir(apiConfig, dir, batchSize, iteratorCallback, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof dir, 'string');
    assert.strictEqual(typeof batchSize, 'number');
    assert.strictEqual(typeof iteratorCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    callback(new Error('not implemented'));
}

function remove(apiConfig, filename, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof filename, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function removeDir(apiConfig, pathPrefix) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');

    // Result: none
    var events = new EventEmitter();
    process.nextTick(function () { events.emit('done', new Error('not implemented')); });
    return events;
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    // Result: none - first callback argument error if config does not pass the test

    callback(new Error('not implemented'));
}

