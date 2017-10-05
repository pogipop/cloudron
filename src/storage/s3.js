'use strict';

exports = module.exports = {
    upload: upload,
    download: download,
    downloadDir: downloadDir,
    copy: copy,

    remove: remove,
    removeDir: removeDir,

    backupDone: backupDone,

    testConfig: testConfig,

    // Used to mock AWS
    _mockInject: mockInject,
    _mockRestore: mockRestore
};

var assert = require('assert'),
    async = require('async'),
    AWS = require('aws-sdk'),
    BackupsError = require('../backups.js').BackupsError,
    config = require('../config.js'),
    debug = require('debug')('box:storage/s3'),
    EventEmitter = require('events'),
    fs = require('fs'),
    chunk = require('lodash.chunk'),
    mkdirp = require('mkdirp'),
    PassThrough = require('stream').PassThrough,
    path = require('path'),
    S3BlockReadStream = require('s3-block-read-stream'),
    superagent = require('superagent');

// test only
var originalAWS;
function mockInject(mock) {
    originalAWS = AWS;
    AWS = mock;
}

function mockRestore() {
    AWS = originalAWS;
}

var gCachedCaasCredentials = { issueDate: null, credentials: null };

function getCaasCredentials(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');
    assert(apiConfig.token);

    if ((new Date() - gCachedCaasCredentials.issueDate) <= (1.75 * 60 * 60 * 1000)) { // caas gives tokens with 2 hour limit
        return callback(null, gCachedCaasCredentials.credentials);
    }

    debug('getCaasCredentials: getting new credentials');

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

        gCachedCaasCredentials = {
            issueDate: new Date(),
            credentials: credentials
        };

        callback(null, credentials);
    });
}

function getBackupCredentials(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (apiConfig.provider === 'caas') return getCaasCredentials(apiConfig, callback);

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
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, `Error uploading ${backupFilePath}: ${error.message}`));
            }

            callback(null);
        });
    });
}

function download(apiConfig, backupFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key: backupFilePath
        };

        var s3 = new AWS.S3(credentials);

        var ps = new PassThrough();
        var multipartDownload = new S3BlockReadStream(s3, params, { blockSize: 64 * 1024 * 1024 /*, logCallback: debug */ });

        multipartDownload.on('error', function (error) {
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

function listDir(apiConfig, backupFilePath, options, iteratorCallback, callback) {
    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var s3 = new AWS.S3(credentials);
        var listParams = {
            Bucket: apiConfig.bucket,
            Prefix: backupFilePath
        };

        var total = 0;

        async.forever(function listAndDownload(foreverCallback) {
            s3.listObjectsV2(listParams, function (error, listData) {
                if (error) {
                    debug('remove: Failed to list %s. Not fatal.', error);
                    return foreverCallback(error);
                }

                debug('listDir: processing %s files (processed %s so far)', listData.Contents.length, total);

                var arr = options.batchSize === 1 ? listData.Contents : chunk(listData.Contents, options.batchSize);

                async.eachLimit(arr, 10, iteratorCallback.bind(null, s3), function iteratorDone(error) {
                    if (error) return foreverCallback(error);

                    total += listData.KeyCount;

                    if (!listData.IsTruncated) return foreverCallback(new Error('Done'));

                    listParams.StartAfter = listData.Contents[listData.Contents.length - 1].Key; // NextMarker is returned only with delimiter

                    foreverCallback();
                });
            });
        }, function (error) {
            if (error.message === 'Done') return callback(null);

            callback(error);
        });
    });
}

function downloadDir(apiConfig, backupFilePath, destDir, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof destDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    listDir(apiConfig, backupFilePath, { batchSize: 1 }, function downloadFile(s3, content, iteratorCallback) {
        var relativePath = path.relative(backupFilePath, content.Key);

        mkdirp(path.dirname(path.join(destDir, relativePath)), function (error) {
            if (error) return iteratorCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

            download(apiConfig, content.Key, function (error, sourceStream) {
                if (error) return iteratorCallback(error);

                var destStream = fs.createWriteStream(path.join(destDir, relativePath));

                destStream.on('open', function () {
                    sourceStream.pipe(destStream);
                });

                destStream.on('error', function (error) {
                    return iteratorCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
                });

                destStream.on('finish', iteratorCallback);
            });
        });
    }, callback);
}

function copy(apiConfig, oldFilePath, newFilePath) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');

    var events = new EventEmitter();

    listDir(apiConfig, oldFilePath, { batchSize: 1 }, function copyFile(s3, content, iteratorCallback) {
        var relativePath = path.relative(oldFilePath, content.Key);

        function done(error) {
            if (error && error.code === 'NoSuchKey') return iteratorCallback(new BackupsError(BackupsError.NOT_FOUND, `Old backup not found: ${content.Key}`));
            if (error) {
                debug('copy: s3 copy error.', error);
                return iteratorCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, `Error copying ${content.Key} : ${error.message}`));
            }

            iteratorCallback(null);
        }

        var copyParams = {
            Bucket: apiConfig.bucket,
            Key: path.join(newFilePath, relativePath)
        };

        // S3 copyObject has a file size limit of 5GB so if we have larger files, we do a multipart copy
        if (content.Size < 5 * 1024 * 1024 * 1024) {
            events.emit('progress', 'Copying ' + content.Key.slice(oldFilePath.length+1));

            copyParams.CopySource = encodeURIComponent(path.join(apiConfig.bucket, content.Key)); // See aws-sdk-js/issues/1302
            return s3.copyObject(copyParams, done);
        }

        events.emit('progress', 'Copying (multipart) ' + content.Key.slice(oldFilePath.length+1));

        s3.createMultipartUpload(copyParams, function (error, result) {
            if (error) return done(error);

            const CHUNK_SIZE = 1024 * 1024 * 1024;  // 1GB - rather random size
            var uploadId = result.UploadId;
            var uploadedParts = [];
            var partNumber = 1;
            var startBytes = 0;
            var endBytes = 0;
            var size = content.Size-1;

            function copyNextChunk() {
                endBytes = startBytes + CHUNK_SIZE;
                if (endBytes > size) endBytes = size;

                var params = {
                    Bucket: apiConfig.bucket,
                    Key: path.join(newFilePath, relativePath),
                    CopySource: encodeURIComponent(path.join(apiConfig.bucket, content.Key)),
                    CopySourceRange: 'bytes=' + startBytes + '-' + endBytes,
                    PartNumber: partNumber,
                    UploadId: uploadId
                };

                s3.uploadPartCopy(params, function (error, result) {
                    if (error) return done(error);

                    uploadedParts.push({ ETag: result.CopyPartResult.ETag, PartNumber: partNumber });

                    if (endBytes < size) {
                        startBytes = endBytes + 1;
                        partNumber++;
                        return copyNextChunk();
                    }

                    var params = {
                        Bucket: apiConfig.bucket,
                        Key: path.join(newFilePath, relativePath),
                        MultipartUpload: { Parts: uploadedParts },
                        UploadId: uploadId
                    };

                    s3.completeMultipartUpload(params, done);
                });
            }

            copyNextChunk();
        });
    }, function (error) {
        events.emit('done', error);
    });

    return events;
}

function remove(apiConfig, filename, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof filename, 'string');
    assert.strictEqual(typeof callback, 'function');

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var s3 = new AWS.S3(credentials);

        var deleteParams = {
            Bucket: apiConfig.bucket,
            Delete: {
                Objects: [{ Key: filename }]
            }
        };

        s3.deleteObjects(deleteParams, function (error) {
            if (error) debug('remove: Unable to remove %s. Not fatal.', deleteParams.Key, error);

            callback(null);
        });
    });
}

function removeDir(apiConfig, pathPrefix, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');
    assert.strictEqual(typeof callback, 'function');

    listDir(apiConfig, pathPrefix, { batchSize: 1000 }, function deleteFiles(s3, contents, iteratorCallback) {
        var deleteParams = {
            Bucket: apiConfig.bucket,
            Delete: {
                Objects: contents.map(function (c) { return { Key: c.Key }; })
            }
        };

        s3.deleteObjects(deleteParams, function (error /*, deleteData */) {
            if (error) {
                debug('removeDir: Unable to remove %s. Not fatal.', deleteParams.Key, error);
                return iteratorCallback(error);
            }
            // debug('removeDir: Deleted: %j Errors: %j', deleteData.Deleted, deleteData.Errors);

            iteratorCallback();
        });
    }, callback);
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (apiConfig.provider === 'caas') {
        if (typeof apiConfig.token !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'token must be a string'));
    } else {
        if (typeof apiConfig.accessKeyId !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'accessKeyId must be a string'));
        if (typeof apiConfig.secretAccessKey !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'secretAccessKey must be a string'));
    }

    if (typeof apiConfig.bucket !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'bucket must be a string'));
    if (typeof apiConfig.prefix !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'prefix must be a string'));
    if ('signatureVersion' in apiConfig && typeof apiConfig.signatureVersion !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'signatureVersion must be a string'));
    if ('endpoint' in apiConfig && typeof apiConfig.endpoint !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'endpoint must be a string'));

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

function backupDone(apiConfig, backupId, appBackupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    if (apiConfig.provider !== 'caas') return callback();

    // CaaS expects filenames instead of backupIds, this means no prefix but a file type extension
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
