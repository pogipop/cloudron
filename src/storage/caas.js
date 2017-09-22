'use strict';

exports = module.exports = {
    upload: upload,
    download: download,
    downloadDir: downloadDir,
    copy: copy,
    remove: remove,

    backupDone: backupDone,

    testConfig: testConfig,
};

var assert = require('assert'),
    async = require('async'),
    AWS = require('aws-sdk'),
    BackupsError = require('../backups.js').BackupsError,
    config = require('../config.js'),
    debug = require('debug')('box:storage/caas'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    PassThrough = require('stream').PassThrough,
    path = require('path'),
    S3BlockReadStream = require('s3-block-read-stream'),
    superagent = require('superagent');

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

// storage api
function upload(apiConfig, backupFilePath, sourceStream, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof sourceStream, 'object');
    assert.strictEqual(typeof callback, 'function');

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);
        var params = {
            Bucket: apiConfig.bucket,
            Key: backupFilePath,
            Body: sourceStream
        };

        var s3 = new AWS.S3(credentials);
        // s3.upload automatically does a multi-part upload. we set queueSize to 1 to reduce memory usage
        s3.upload(params, { partSize: 10 * 1024 * 1024, queueSize: 1 }, function (error) {
            if (error) {
                debug('[%s] upload: s3 upload error.', backupFilePath, error);
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));
            }

            callback(null);
        });
    });
}

function download(apiConfig, backupFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('download: %s', backupFilePath);

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key: backupFilePath
        };

        var s3 = new AWS.S3(credentials);

        var ps = new PassThrough();
        var multipartDownload = new S3BlockReadStream(s3, params, { blockSize: 64 * 1024 * 1024, logCallback: debug });

        multipartDownload.on('error', function (error) {
            // TODO ENOENT for the mock, fix upstream!
            if (error.code === 'NoSuchKey' || error.code === 'ENOENT') {
                ps.emit('error', new BackupsError(BackupsError.NOT_FOUND));
            } else {
                debug('[%s] download: s3 stream error.', backupFilePath, error);
                ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
            }
        });

        multipartDownload.pipe(ps);

        callback(null, ps);
    });
}

function downloadDir(apiConfig, backupFilePath, destDir, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof destDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var s3 = new AWS.S3(credentials);
        var listParams = {
            Bucket: apiConfig.bucket,
            Prefix: backupFilePath
        };

        async.forever(function listAndDownload(foreverCallback) {
            s3.listObjectsV2(listParams, function (error, listData) {
                if (error) {
                    debug('remove: Failed to list %s. Not fatal.', error);
                    return foreverCallback(error);
                }

                async.eachLimit(listData.Contents, 10, function downloadFile(content, iteratorCallback) {
                    var relativePath = path.relative(backupFilePath, content.Key);
                    mkdirp(path.dirname(path.join(destDir, relativePath)), function (error) {
                        if (error) return iteratorCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

                        var destStream = fs.createWriteStream(path.join(destDir, relativePath));
                        destStream.on('error', function (error) {
                            return iteratorCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
                        });
                        download(apiConfig, content.Key, destStream, iteratorCallback);
                    });
                }, function doneCopying(error) {
                    if (error) return foreverCallback(error);

                    if (listData.IsTruncated) return foreverCallback();

                    foreverCallback(new Error('Done'));
                });
            });
        }, function (error) {
            if (error.message === 'Done') return callback();
            callback(error);
        });
    });
}

function copy(apiConfig, oldFilePath, newFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var s3 = new AWS.S3(credentials);
        var listParams = {
            Bucket: apiConfig.bucket,
            Prefix: oldFilePath
        };

        async.forever(function listAndDelete(foreverCallback) {
            s3.listObjectsV2(listParams, function (error, listData) {
                if (error) {
                    debug('remove: Failed to list %s. Not fatal.', error);
                    return foreverCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
                }

                async.eachLimit(listData.Contents, 10, function copyFile(content, iteratorCallback) {
                    var relativePath = path.relative(oldFilePath, content.Key);

                    var copyParams = {
                        Bucket: apiConfig.bucket,
                        Key: path.join(newFilePath, relativePath),
                        CopySource: path.join(apiConfig.bucket, content.Key)
                    };

                    s3.copyObject(copyParams, function (error) {
                        if (error && error.code === 'NoSuchKey') return iteratorCallback(new BackupsError(BackupsError.NOT_FOUND, 'Old backup not found'));
                        if (error) {
                            debug('copy: s3 copy error.', error);
                            return iteratorCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
                        }

                        iteratorCallback();
                    });
                }, function doneCopying(error) {
                    if (error) return foreverCallback(error);

                    if (listData.IsTruncated) return foreverCallback();

                    foreverCallback(new Error('Done'));
                });
            });
        }, function (error) {
            if (error.message === 'Done') return callback();
            callback(error);
        });
    });
}

function remove(apiConfig, pathPrefix, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');
    assert.strictEqual(typeof callback, 'function');

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var s3 = new AWS.S3(credentials);
        var listParams = {
            Bucket: apiConfig.bucket,
            Prefix: pathPrefix
        };

        async.forever(function listAndDelete(iteratorCallback) {
            s3.listObjectsV2(listParams, function (error, listData) {
                if (error) {
                    debug('remove: Failed to list %s. Not fatal.', error);
                    return iteratorCallback(error);
                }

                var deleteParams = {
                    Bucket: apiConfig.bucket,
                    Delete: {
                        Objects: listData.Contents.map(function (c) { return { Key: c.Key }; })
                    }
                };

                s3.deleteObjects(deleteParams, function (error, deleteData) {
                    if (error) {
                        debug('remove: Unable to remove %s. Not fatal.', deleteParams.Key, error);
                        return iteratorCallback(error);
                    }

                    debug('remove: Deleted: %j Errors: %j', deleteData.Deleted, deleteData.Errors);

                    listParams.Marker = listData[listData.length - 1].Key; // NextMarker is returned only with delimiter

                    if (deleteData.IsTruncated) return iteratorCallback();

                    iteratorCallback(new Error('Done'));
                });
            });
        }, function (/*ignoredError*/) {
            if (error.message === 'Done') return callback(null);

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
    var FILE_TYPE = '.tar.gz.enc';
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
