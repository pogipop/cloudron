'use strict';

exports = module.exports = {
    backup: backup,
    restore: restore,
    copyBackup: copyBackup,
    removeBackups: removeBackups,

    backupDone: backupDone,

    testConfig: testConfig,
};

var assert = require('assert'),
    AWS = require('aws-sdk'),
    BackupsError = require('../backups.js').BackupsError,
    config = require('../config.js'),
    debug = require('debug')('box:storage/caas'),
    once = require('once'),
    PassThrough = require('stream').PassThrough,
    path = require('path'),
    S3BlockReadStream = require('s3-block-read-stream'),
    superagent = require('superagent'),
    targz = require('./targz.js');

var FILE_TYPE = '.tar.gz.enc';

// internal only
function getBackupCredentials(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');
    assert(apiConfig.token);

    var url = config.apiServerOrigin() + '/api/v1/boxes/' + config.fqdn() + '/awscredentials';
    superagent.post(url).query({ token: apiConfig.token }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(error);
        if (result.statusCode !== 201) return callback(new Error(result.text));
        if (!result.body || !result.body.credentials) return callback(new Error('Unexpected response: ' + JSON.stringify(result.headers)));

        var credentials = {
            signatureVersion: 'v4',
            accessKeyId: result.body.credentials.AccessKeyId,
            secretAccessKey: result.body.credentials.SecretAccessKey,
            sessionToken: result.body.credentials.SessionToken,
            region: apiConfig.region || 'us-east-1'
        };

        if (apiConfig.endpoint) credentials.endpoint = new AWS.Endpoint(apiConfig.endpoint);

        callback(null, credentials);
    });
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
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));
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
            if (error && error.code === 'NoSuchKey') return callback(new BackupsError(BackupsError.NOT_FOUND));
            if (error) {
                debug('copyBackup: s3 copy error.', error);
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));
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
            if (error) debug('Unable to remove %s. Not fatal.', params.Key, error);
            else debug('removeBackups: Deleted: %j Errors: %j', data.Deleted, data.Errors);

            callback(null);
        });
    });
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (config.provider() !== 'caas') return callback(new BackupsError(BackupsError.BAD_FIELD, 'instance provider must be caas'));

    callback();
}

function backupDone(backupId, appBackupIds, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    // Caas expects filenames instead of backupIds, this means no prefix but a file type extension
    var boxBackupFilename = backupId + FILE_TYPE;
    var appBackupFilenames = appBackupIds.map(function (id) { return id + FILE_TYPE; });

    debug('[%s] backupDone: %s apps %j', backupId, boxBackupFilename, appBackupFilenames);

    var url = config.apiServerOrigin() + '/api/v1/boxes/' + config.fqdn() + '/backupDone';
    var data = {
        boxVersion: config.version(),
        restoreKey: boxBackupFilename,
        appId: null,        // now unused
        appVersion: null,   // now unused
        appBackupIds: appBackupFilenames
    };

    superagent.post(url).send(data).query({ token: config.token() }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));
        if (result.statusCode !== 200) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, result.text));

        return callback(null);
    });
}
