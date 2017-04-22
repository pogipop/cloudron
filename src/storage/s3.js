'use strict';

exports = module.exports = {
    backup: backup,
    restore: restore,
    copyBackup: copyBackup,
    removeBackup: removeBackup,

    backupDone: backupDone,

    testConfig: testConfig,

    // Used to mock AWS
    _mockInject: mockInject,
    _mockRestore: mockRestore
};

var assert = require('assert'),
    AWS = require('aws-sdk'),
    BackupsError = require('../backups.js').BackupsError,
    debug = require('debug')('box:storage/s3'),
    once = require('once'),
    PassThrough = require('stream').PassThrough,
    path = require('path'),
    targz = require('./targz.js');

var FILE_TYPE = '.tar.gz.enc';

// test only
var originalAWS;
function mockInject(mock) {
    originalAWS = AWS;
    AWS = mock;
}

function mockRestore() {
    AWS = originalAWS;
}

// internal only
function getBackupCredentials(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    assert(apiConfig.accessKeyId && apiConfig.secretAccessKey);

    var credentials = {
        signatureVersion: apiConfig.signatureVersion || 'v4',
        s3ForcePathStyle: true,
        accessKeyId: apiConfig.accessKeyId,
        secretAccessKey: apiConfig.secretAccessKey,
        region: apiConfig.region || 'us-east-1'
    };

    if (apiConfig.endpoint) credentials.endpoint = apiConfig.endpoint;

    callback(null, credentials);
}

function getBackupFilePath(apiConfig, backupId) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');

    return path.join(apiConfig.prefix, backupId.endsWith(FILE_TYPE) ? backupId : backupId+FILE_TYPE);
}

// storage api
function backup(apiConfig, backupId, sourceDirectories, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(sourceDirectories));
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] backup: %j -> %s', backupId, sourceDirectories, backupFilePath);

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var passThrough = new PassThrough();

        var params = {
            Bucket: apiConfig.bucket,
            Key: backupFilePath,
            Body: passThrough
        };

        var s3 = new AWS.S3(credentials);
        s3.upload(params, function (error) {
            if (error) {
                console.error('[%s] backup: s3 upload error.', backupId, error);
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
            }

            callback(null);
        });

        targz.create(sourceDirectories, apiConfig.key, passThrough, callback);
    });
}

function restore(apiConfig, backupId, destination, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var isOldFormat = backupId.endsWith('.tar.gz');
    var backupFilePath = isOldFormat ? path.join(apiConfig.prefix, backupId) : getBackupFilePath(apiConfig, backupId);

    debug('[%s] restore: %s -> %s', backupId, backupFilePath, destination);

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key: backupFilePath
        };

        var s3 = new AWS.S3(credentials);

        var s3get = s3.getObject(params).createReadStream();

        s3get.on('error', function (error) {
            // TODO ENOENT for the mock, fix upstream!
            if (error.code === 'NoSuchKey' || error.code === 'ENOENT') return callback(new BackupsError(BackupsError.NOT_FOUND));

            console.error('[%s] restore: s3 stream error.', backupId, error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        targz.extract(s3get, isOldFormat, destination, apiConfig.key || '', callback);
    });
}

function copyBackup(apiConfig, oldBackupId, newBackupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldBackupId, 'string');
    assert.strictEqual(typeof newBackupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key: getBackupFilePath(apiConfig, newBackupId),
            CopySource: path.join(apiConfig.bucket, getBackupFilePath(apiConfig, oldBackupId))
        };

        var s3 = new AWS.S3(credentials);
        s3.copyObject(params, function (error) {
            if (error && error.code === 'NoSuchKey') return callback(new BackupsError(BackupsError.NOT_FOUND, 'Old backup not found'));
            if (error) {
                console.error('copyBackup: s3 copy error.', error);
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
            }

            callback(null);
        });
    });
}

function removeBackup(apiConfig, backupId, appBackupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key:  getBackupFilePath(apiConfig, backupId)
        };

        var s3 = new AWS.S3(credentials);
        s3.deleteObject(params, function (error) {
            if (error) console.error('Unable to remove %s. Not fatal.', params.Key, error);
            callback(null);
        });
    });
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (typeof apiConfig.accessKeyId !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'accessKeyId must be a string'));
    if (typeof apiConfig.secretAccessKey !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'secretAccessKey must be a string'));
    if (typeof apiConfig.bucket !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'bucket must be a string'));
    if (typeof apiConfig.prefix !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'prefix must be a string'));
    if ('signatureVersion' in apiConfig && typeof apiConfig.prefix !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'signatureVersion must be a string'));
    if ('endpoint' in apiConfig && typeof apiConfig.prefix !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'endpoint must be a string'));

    // attempt to upload and delete a file with new credentials
    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key: apiConfig.prefix + '/cloudron-testfile',
            Body: 'testcontent'
        };

        var s3 = new AWS.S3(credentials);
        s3.putObject(params, function (error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

            var params = {
                Bucket: apiConfig.bucket,
                Key: apiConfig.prefix + '/cloudron-testfile'
            };

            s3.deleteObject(params, function (error) {
                if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

                callback();
            });
        });
    });
}

function backupDone(backupId, appBackupIds, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback();
}
