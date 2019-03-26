'use strict';

exports = module.exports = {
    upload: upload,
    download: download,
    copy: copy,

    listDir: listDir,

    remove: remove,
    removeDir: removeDir,

    testConfig: testConfig,
    removePrivateFields: removePrivateFields,
    injectPrivateFields: injectPrivateFields,

    // Used to mock AWS
    _mockInject: mockInject,
    _mockRestore: mockRestore
};

var assert = require('assert'),
    async = require('async'),
    AWS = require('aws-sdk'),
    backups = require('../backups.js'),
    BackupsError = require('../backups.js').BackupsError,
    chunk = require('lodash.chunk'),
    config = require('../config.js'),
    debug = require('debug')('box:storage/s3'),
    EventEmitter = require('events'),
    https = require('https'),
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

function S3_NOT_FOUND(error) {
    return error.code === 'NoSuchKey' || error.code === 'NotFound' || error.code === 'ENOENT';
}

function getCaasConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');
    assert(apiConfig.token);

    if ((new Date() - gCachedCaasCredentials.issueDate) <= (1.75 * 60 * 60 * 1000)) { // caas gives tokens with 2 hour limit
        return callback(null, gCachedCaasCredentials.credentials);
    }

    debug('getCaasCredentials: getting new credentials');

    var url = config.apiServerOrigin() + '/api/v1/boxes/' + apiConfig.fqdn + '/awscredentials';
    superagent.post(url).query({ token: apiConfig.token }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(error);
        if (result.statusCode !== 201) return callback(new Error(result.text));
        if (!result.body || !result.body.credentials) return callback(new Error('Unexpected response: ' + JSON.stringify(result.headers)));

        var credentials = {
            signatureVersion: 'v4',
            accessKeyId: result.body.credentials.AccessKeyId,
            secretAccessKey: result.body.credentials.SecretAccessKey,
            sessionToken: result.body.credentials.SessionToken,
            region: apiConfig.region || 'us-east-1',
            maxRetries: 5,
            retryDelayOptions: {
                customBackoff: () => 20000 // constant backoff - https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Config.html#retryDelayOptions-property
            },
            httpOptions: {
                connectTimeout: 10000, // https://github.com/aws/aws-sdk-js/pull/1446
                timeout: 300 * 1000 // https://github.com/aws/aws-sdk-js/issues/1704 (allow 5MB chunk upload to take upto 5 minutes)
            }
        };

        if (apiConfig.endpoint) credentials.endpoint = new AWS.Endpoint(apiConfig.endpoint);

        gCachedCaasCredentials = {
            issueDate: new Date(),
            credentials: credentials
        };

        callback(null, credentials);
    });
}

function getS3Config(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (apiConfig.provider === 'caas') return getCaasConfig(apiConfig, callback);

    var credentials = {
        signatureVersion: apiConfig.signatureVersion || 'v4',
        s3ForcePathStyle: true, // Force use path-style url (http://endpoint/bucket/path) instead of host-style (http://bucket.endpoint/path)
        accessKeyId: apiConfig.accessKeyId,
        secretAccessKey: apiConfig.secretAccessKey,
        region: apiConfig.region || 'us-east-1',
        maxRetries: 5,
        retryDelayOptions: {
            customBackoff: () => 20000 // constant backoff - https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Config.html#retryDelayOptions-property
        },
        httpOptions: {
            connectTimeout: 10000, // https://github.com/aws/aws-sdk-js/pull/1446
            timeout: 300 * 1000 // https://github.com/aws/aws-sdk-js/issues/1704 (allow 5MB chunk upload to take upto 5 minutes)
        }
    };

    if (apiConfig.endpoint) credentials.endpoint = apiConfig.endpoint;

    if (apiConfig.acceptSelfSignedCerts === true && credentials.endpoint && credentials.endpoint.startsWith('https://')) {
        credentials.httpOptions.agent = new https.Agent({ rejectUnauthorized: false });
    }
    callback(null, credentials);
}

// storage api
function upload(apiConfig, backupFilePath, sourceStream, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof sourceStream, 'object');
    assert.strictEqual(typeof callback, 'function');

    getS3Config(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key: backupFilePath,
            Body: sourceStream
        };

        var s3 = new AWS.S3(credentials);

        // s3.upload automatically does a multi-part upload. we set queueSize to 1 to reduce memory usage
        // uploader will buffer at most queueSize * partSize bytes into memory at any given time.
        s3.upload(params, { partSize: 10 * 1024 * 1024, queueSize: 1 }, function (error, data) {
            if (error) {
                debug('Error uploading [%s]: s3 upload error.', backupFilePath, error);
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, `Error uploading ${backupFilePath}. Message: ${error.message} HTTP Code: ${error.code}`));
            }

            debug(`Uploaded ${backupFilePath}: ${JSON.stringify(data)}`);

            callback(null);
        });
    });
}

function download(apiConfig, backupFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    getS3Config(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key: backupFilePath
        };

        var s3 = new AWS.S3(credentials);

        var ps = new PassThrough();
        var multipartDownload = new S3BlockReadStream(s3, params, { blockSize: 64 * 1024 * 1024 /*, logCallback: debug */ });

        multipartDownload.on('error', function (error) {
            if (S3_NOT_FOUND(error)) {
                ps.emit('error', new BackupsError(BackupsError.NOT_FOUND, `Backup not found: ${backupFilePath}`));
            } else {
                debug(`download: ${apiConfig.bucket}:${backupFilePath} s3 stream error.`, error);
                ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message || error.code)); // DO sets 'code'
            }
        });

        multipartDownload.pipe(ps);

        callback(null, ps);
    });
}

function listDir(apiConfig, dir, batchSize, iteratorCallback, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof dir, 'string');
    assert.strictEqual(typeof batchSize, 'number');
    assert.strictEqual(typeof iteratorCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    getS3Config(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var s3 = new AWS.S3(credentials);
        var listParams = {
            Bucket: apiConfig.bucket,
            Prefix: dir,
            MaxKeys: batchSize
        };

        async.forever(function listAndDownload(foreverCallback) {
            s3.listObjects(listParams, function (error, listData) {
                if (error) return foreverCallback(error);

                if (listData.Contents.length === 0) return foreverCallback(new Error('Done'));

                const entries = listData.Contents.map(function (c) { return { fullPath: c.Key, size: c.Size }; });

                iteratorCallback(entries, function (error) {
                    if (error) return foreverCallback(error);

                    if (!listData.IsTruncated) return foreverCallback(new Error('Done'));

                    listParams.Marker = listData.Contents[listData.Contents.length - 1].Key; // NextMarker is returned only with delimiter

                    foreverCallback();
                });
            });
        }, function (error) {
            if (error.message === 'Done') return callback(null);

            callback(error);
        });
    });
}

// https://github.com/aws/aws-sdk-js/blob/2b6bcbdec1f274fe931640c1b61ece999aae7a19/lib/util.js#L41
// https://github.com/GeorgePhillips/node-s3-url-encode/blob/master/index.js
// See aws-sdk-js/issues/1302
function encodeCopySource(bucket, path) {
    var output = encodeURI(path);

    // AWS percent-encodes some extra non-standard characters in a URI
    output = output.replace(/[+!"#$@&'()*+,:;=?@]/g, function(ch) {
        return '%' + ch.charCodeAt(0).toString(16).toUpperCase();
    });

    // the slash at the beginning is optional
    return `/${bucket}/${output}`;
}

function copy(apiConfig, oldFilePath, newFilePath) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');

    var events = new EventEmitter(), retryCount = 0;

    function copyFile(entry, iteratorCallback) {
        getS3Config(apiConfig, function (error, credentials) {
            if (error) return iteratorCallback(error);

            var s3 = new AWS.S3(credentials);
            var relativePath = path.relative(oldFilePath, entry.fullPath);

            function done(error) {
                if (error) debug(`copy: s3 copy error when copying ${entry.fullPath}: ${error}`);

                if (error && S3_NOT_FOUND(error)) return iteratorCallback(new BackupsError(BackupsError.NOT_FOUND, `Old backup not found: ${entry.fullPath}`));
                if (error) return iteratorCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, `Error copying ${entry.fullPath} : ${error.code} ${error}`));

                iteratorCallback(null);
            }

            var copyParams = {
                Bucket: apiConfig.bucket,
                Key: path.join(newFilePath, relativePath)
            };

            // S3 copyObject has a file size limit of 5GB so if we have larger files, we do a multipart copy
            // Exoscale takes too long to copy 5GB
            const largeFileLimit = apiConfig.provider === 'exoscale-sos' ? 1024 * 1024 * 1024 : 5 * 1024 * 1024 * 1024;

            if (entry.size < largeFileLimit) {
                events.emit('progress', `Copying ${relativePath || oldFilePath}`);

                copyParams.CopySource = encodeCopySource(apiConfig.bucket, entry.fullPath);
                s3.copyObject(copyParams, done).on('retry', function (response) {
                    ++retryCount;
                    events.emit('progress', `Retrying (${response.retryCount+1}) copy of ${relativePath || oldFilePath}. Error: ${response.error} ${response.httpResponse.statusCode}`);
                    // on DO, we get a random 408. these are not retried by the SDK
                    if (response.error) response.error.retryable = true; // https://github.com/aws/aws-sdk-js/issues/412
                });

                return;
            }

            events.emit('progress', `Copying (multipart) ${relativePath || oldFilePath}`);

            s3.createMultipartUpload(copyParams, function (error, result) {
                if (error) return done(error);

                // Exoscale (96M) was suggested by exoscale. 1GB - rather random size for others
                const chunkSize = apiConfig.provider === 'exoscale-sos' ? 96 * 1024 * 1024 : 1024 * 1024 * 1024;
                var uploadId = result.UploadId;
                var uploadedParts = [];
                var partNumber = 1;
                var startBytes = 0;
                var endBytes = 0;
                var size = entry.size-1;

                function copyNextChunk() {
                    endBytes = startBytes + chunkSize;
                    if (endBytes > size) endBytes = size;

                    var params = {
                        Bucket: apiConfig.bucket,
                        Key: path.join(newFilePath, relativePath),
                        CopySource: encodeCopySource(apiConfig.bucket, entry.fullPath), // See aws-sdk-js/issues/1302
                        CopySourceRange: 'bytes=' + startBytes + '-' + endBytes,
                        PartNumber: partNumber,
                        UploadId: uploadId
                    };

                    events.emit('progress', `Copying part ${params.PartNumber} - ${params.CopySource} ${params.CopySourceRange}`);

                    s3.uploadPartCopy(params, function (error, result) {
                        if (error) return done(error);

                        events.emit('progress', `Uploaded part ${params.PartNumber} - Etag: ${result.CopyPartResult.ETag}`);

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

                        events.emit('progress', `Finishing multipart copy - ${params.Key}`);

                        s3.completeMultipartUpload(params, done);
                    }).on('retry', function (response) {
                        ++retryCount;
                        events.emit('progress', `Retrying (${response.retryCount+1}) multipart copy of ${relativePath || oldFilePath}. Error: ${response.error} ${response.httpResponse.statusCode}`);
                    });
                }

                copyNextChunk();
            });
        });
    }

    var total = 0;
    const concurrency = apiConfig.copyConcurrency || (apiConfig.provider === 's3' ? 500 : 10);

    listDir(apiConfig, oldFilePath, 1000, function listDirIterator(entries, done) {
        total += entries.length;

        events.emit('progress', `Copying ${total-entries.length}-${total}. ${retryCount} errors so far. concurrency set to ${concurrency}`);
        retryCount = 0;

        async.eachLimit(entries, concurrency, copyFile, done);
    }, function (error) {
        events.emit('progress', `Copied ${total} files with error: ${error}`);

        events.emit('done', error);
    });

    return events;
}

function remove(apiConfig, filename, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof filename, 'string');
    assert.strictEqual(typeof callback, 'function');

    getS3Config(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var s3 = new AWS.S3(credentials);

        var deleteParams = {
            Bucket: apiConfig.bucket,
            Delete: {
                Objects: [{ Key: filename }]
            }
        };

        // deleteObjects does not return error if key is not found
        s3.deleteObjects(deleteParams, function (error) {
            if (error) debug(`remove: Unable to remove ${deleteParams.Key}. error: ${error.message}`);

            callback(error);
        });
    });
}

function removeDir(apiConfig, pathPrefix) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');

    var events = new EventEmitter();
    var total = 0;

    getS3Config(apiConfig, function (error, credentials) {
        if (error) events.emit('done', error);

        var s3 = new AWS.S3(credentials);

        listDir(apiConfig, pathPrefix, 1000, function listDirIterator(entries, done) {
            total += entries.length;

            const chunkSize = apiConfig.provider !== 'digitalocean-spaces' ? 1000 : 100; // throttle objects in each request
            var chunks = chunk(entries, chunkSize);

            async.eachSeries(chunks, function deleteFiles(objects, iteratorCallback) {
                var deleteParams = {
                    Bucket: apiConfig.bucket,
                    Delete: {
                        Objects: objects.map(function (o) { return { Key: o.fullPath }; })
                    }
                };

                events.emit('progress', `Removing ${objects.length} files from ${objects[0].fullPath} to ${objects[objects.length-1].fullPath}`);

                // deleteObjects does not return error if key is not found
                s3.deleteObjects(deleteParams, function (error /*, deleteData */) {
                    if (error) events.emit('progress', `Unable to remove ${deleteParams.Key} ${error.message}`);

                    iteratorCallback(error);
                });
            }, done);
        }, function (error) {
            events.emit('progress', `Removed ${total} files`);

            events.emit('done', error);
        });
    });

    return events;
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
    getS3Config(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key: path.join(apiConfig.prefix, 'cloudron-testfile'),
            Body: 'testcontent'
        };

        var s3 = new AWS.S3(credentials);
        s3.putObject(params, function (error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message || error.code)); // DO sets 'code'

            var params = {
                Bucket: apiConfig.bucket,
                Key: path.join(apiConfig.prefix, 'cloudron-testfile')
            };

            s3.deleteObject(params, function (error) {
                if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message || error.code)); // DO sets 'code'

                callback();
            });
        });
    });
}

function removePrivateFields(apiConfig) {
    apiConfig.secretAccessKey = backups.SECRET_PLACEHOLDER;
    return apiConfig;
}

function injectPrivateFields(newConfig, currentConfig) {
    if (newConfig.secretAccessKey === backups.SECRET_PLACEHOLDER) newConfig.secretAccessKey = currentConfig.secretAccessKey;
}
