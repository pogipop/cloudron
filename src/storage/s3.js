'use strict';

exports = module.exports = {
    backup: backup,
    restore: restore,
    copyBackup: copyBackup,
    removeBackups: removeBackups,

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
    S3BlockReadStream = require('s3-block-read-stream'),
    targz = require('./targz.js');

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

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var passThrough = new PassThrough();

        var params = {
            Bucket: apiConfig.bucket,
            Key: backupFilePath,
            Body: passThrough
        };

        var s3 = new AWS.S3(credentials);
        // s3.upload automatically does a multi-part upload. we set queueSize to 1 to reduce memory usage
        s3.upload(params, { partSize: 10 * 1024 * 1024, queueSize: 1 }, function (error) {
            if (error) {
                debug('[%s] backup: s3 upload error.', backupId, error);
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
            }

            callback(null);
        });

        targz.create([{ source: sourceDir, destination: '.' }], apiConfig.key || null, passThrough, callback);
    });
}

function restore(apiConfig, backupId, destination, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] restore: %s -> %s', backupId, backupFilePath, destination);

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key: backupFilePath
        };

        var s3 = new AWS.S3(credentials);

        var multipartDownload = new S3BlockReadStream(s3, params, { blockSize: 64 * 1024 * 1024, logCallback: debug });

        multipartDownload.on('error', function (error) {
            // TODO ENOENT for the mock, fix upstream!
            if (error.code === 'NoSuchKey' || error.code === 'ENOENT') return callback(new BackupsError(BackupsError.NOT_FOUND));

            debug('[%s] restore: s3 stream error.', backupId, error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        targz.extract(multipartDownload, destination, apiConfig.key || null, callback);
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
                debug('copyBackup: s3 copy error.', error);
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
            }

            callback(null);
        });
    });
}

function removeBackups(apiConfig, backupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert(Array.isArray(backupIds));
    assert.strictEqual(typeof callback, 'function');

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Delete: {
                Objects: [ ] // { Key }
            }
        };

        backupIds.forEach(function (backupId) {
            params.Delete.Objects.push({ Key: getBackupFilePath(apiConfig, backupId) });
        });

        var s3 = new AWS.S3(credentials);
        s3.deleteObjects(params, function (error, data) {
            if (error) debug('removeBackups: Unable to remove %s. Not fatal.', params.Key, error);
            else debug('removeBackups: Deleted: %j Errors: %j', data.Deleted, data.Errors);

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
            Key: path.join(apiConfig.prefix, 'cloudron-testfile'),
            Body: 'testcontent'
        };

        var s3 = new AWS.S3(credentials);
        s3.putObject(params, function (error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

            var params = {
                Bucket: apiConfig.bucket,
                Key: path.join(apiConfig.prefix, 'cloudron-testfile')
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
