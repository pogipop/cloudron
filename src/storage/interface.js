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

    remove: remove,
    removeDir: removeDir,

    testConfig: testConfig
};

var assert = require('assert'),
    EventEmitter = require('events');

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

