'use strict';

exports = module.exports = {
    backup: backup,
    restore: restore,
    copyBackup: copyBackup,
    removeBackups: removeBackups,

    backupDone: backupDone,

    testConfig: testConfig,

    // Used to mock GCS
    _mockInject: mockInject,
    _mockRestore: mockRestore
};

var assert = require('assert'),
    GCS = require('@google-cloud/storage'),
    BackupsError = require('../backups.js').BackupsError,
    debug = require('debug')('box:storage/gcs'),
    once = require('once'),
    PassThrough = require('stream').PassThrough,
    path = require('path'),
    async = require('async'),
    targz = require('./targz.js');

// test only
var originalGCS;
function mockInject(mock) {
    originalGCS = GCS;
    GCS = mock;
}

function mockRestore() {
    GCS = originalGCS;
}

// internal only
function getBackupCredentials(backupConfig) {
    assert.strictEqual(typeof backupConfig, 'object');

    var config = {
        provider: backupConfig.provider,
        projectId: backupConfig.projectId,
        keyFilename: backupConfig.keyFilename,
    };

    if (backupConfig.credentials) {
        config.credentials = {
            client_email: backupConfig.credentials.client_email,
            private_key: backupConfig.credentials.private_key
        };
    }
    return config;
}

function getBucket(apiConfig) {
    var credentials = getBackupCredentials(apiConfig);
    return GCS(credentials).bucket(apiConfig.bucket);
}

function getBackupFilePath(apiConfig, backupId) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');

    const FILE_TYPE = apiConfig.key ? '.tar.gz.enc' : '.tar.gz';

    return path.join(apiConfig.prefix, backupId.endsWith(FILE_TYPE) ? backupId : backupId+FILE_TYPE);
}

// storage api
function backup(apiConfig, backupId, sourceDir, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof sourceDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] backup: %s -> %s', backupId, sourceDir, backupFilePath);

    var bucket = getBucket(apiConfig);
    var uploadingFile = bucket.file(backupFilePath);

    var uploadStream = uploadingFile.createWriteStream({resumable: false})
        .on('finish', callback.bind(null, null))
        .on('error', function(e){
            if (e) callback(new BackupsError(BackupsError.EXTERNAL_ERROR, e.message));
        })
    ;
    targz.create([{ source: sourceDir, destination: '.' }], apiConfig.key || null, uploadStream, callback);
    return uploadStream;
}

function restore(apiConfig, backupId, destination, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] restore: %s -> %s', backupId, backupFilePath, destination);

    var file = getBucket(apiConfig).file(backupFilePath);

    var readStream = file.createReadStream()
        .on('error', function(e){
            if (e && e.code == 404) return callback(new BackupsError(BackupsError.NOT_FOUND, e));
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, e));
        })
    ;
    targz.extract(readStream, destination, apiConfig.key || null, callback);
}

function copyBackup(apiConfig, oldBackupId, newBackupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldBackupId, 'string');
    assert.strictEqual(typeof newBackupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var bucket = getBucket(apiConfig);

    bucket
        .file(getBackupFilePath(apiConfig, oldBackupId))
        .copy(getBackupFilePath(apiConfig, newBackupId), function(error, newFile, apiResponse){
            if (error && error.code == 404) return callback(new BackupsError(BackupsError.NOT_FOUND, 'Old backup not found'));
            if (error) {
                debug('copyBackup: gcs copy error.', e);
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
            }

            callback(null);
        });
}

function removeBackups(apiConfig, backupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert(Array.isArray(backupIds));
    assert.strictEqual(typeof callback, 'function');

    var bucket = getBucket(apiConfig);

    var removeQueue = [];
    backupIds.forEach(function (backupId) {
        removeQueue.push(function(cb){
            var filePath = getBackupFilePath(apiConfig, backupId);
            bucket.file(filePath).delete(function(e){
                if (e) debug('removeBackups: Unable to remove %s (%s). Not fatal.', filePath, e.message);
                else debug('removeBackups: Deleted: %s', filePath);
                cb(typeof e == 'undefined');
            });
        });
    });

    async.series(removeQueue, callback);
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (typeof apiConfig.projectId !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'projectId must be a string'));
    if (typeof apiConfig.keyFilename !== 'string') {
        if (typeof apiConfig.credentials !== 'object') return callback(new BackupsError(BackupsError.BAD_FIELD, 'credentials must be an object'));
        if (typeof apiConfig.credentials.client_email !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'credentials.client_email must be a string'));
        if (typeof apiConfig.credentials.private_key !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'credentials.private_key must be a string'));
    }

    if (typeof apiConfig.bucket !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'bucket must be a string'));
    if (typeof apiConfig.prefix !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'prefix must be a string'));

    // attempt to upload and delete a file with new credentials
    var bucket = getBucket(apiConfig);
    var testFile = bucket.file(path.join(apiConfig.prefix, 'cloudron-testfile'));
    var uploadStream = testFile.createWriteStream({resumable: false});

    var testfileStream = new PassThrough();
    testfileStream.write("testfilecontents");
    testfileStream.end();

    testfileStream
        .on('error', function(error){
            debug('failed uploading cloudron-testfile', error);
            return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        })
        .on('end', function(){
            debug('uploaded cloudron-testfile');
            testFile.delete(function(error){
                if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
                debug('deleted cloudron-testfile');
                callback();
            });
        })
    .pipe(uploadStream);

}

function backupDone(backupId, appBackupIds, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback();
}
