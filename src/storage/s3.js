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
    chunk = require('lodash.chunk'),
    config = require('../config.js'),
    debug = require('debug')('box:storage/s3'),
    EventEmitter = require('events'),
    fs = require('fs'),
    https = require('https'),
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
                base: 20000         // 2^5 * 20 seconds
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
            base: 20000         // 2^5 * 20 seconds
        }
    };

    if (apiConfig.endpoint) credentials.endpoint = apiConfig.endpoint;

    if (apiConfig.acceptSelfSignedCerts === true && credentials.endpoint && credentials.endpoint.startsWith('https://')) {
        credentials.httpOptions.agent = {
            agent: new https.Agent({ rejectUnauthorized: false })
        };
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
        s3.upload(params, { partSize: 10 * 1024 * 1024, queueSize: 1 }, function (error) {
            if (error) {
                debug('[%s] upload: s3 upload error.', backupFilePath, error);
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, `Error uploading ${backupFilePath}. Message: ${error.message} HTTP Code: ${error.code}`));
            }

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
            if (error.code === 'NoSuchKey' || error.code === 'ENOENT') {
                ps.emit('error', new BackupsError(BackupsError.NOT_FOUND));
            } else {
                debug(`download: ${apiConfig.bucket}:${backupFilePath} s3 stream error.`, error);
                ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message || error.code)); // DO sets 'code'
            }
        });

        multipartDownload.pipe(ps);

        callback(null, ps);
    });
}

function listDir(apiConfig, backupFilePath, iteratorCallback, callback) {
    getS3Config(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var s3 = new AWS.S3(credentials);
        var listParams = {
            Bucket: apiConfig.bucket,
            Prefix: backupFilePath
        };

        async.forever(function listAndDownload(foreverCallback) {
            s3.listObjects(listParams, function (error, listData) {
                if (error) {
                    debug('remove: Failed to list %s. Not fatal.', error);
                    return foreverCallback(error);
                }

                if (listData.Contents.length === 0) return foreverCallback(new Error('Done'));

                iteratorCallback(s3, listData.Contents, function (error) {
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

function downloadDir(apiConfig, backupFilePath, destDir) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof destDir, 'string');

    var events = new EventEmitter();
    var total = 0;

    function downloadFile(s3, content, iteratorCallback) {
        var relativePath = path.relative(backupFilePath, content.Key);

        events.emit('progress', `Downloading ${relativePath}`);

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
    }

    const concurrency = 10;

    listDir(apiConfig, backupFilePath, function (s3, objects, done) {
        total += objects.length;
        async.eachLimit(objects, concurrency, downloadFile.bind(null, s3), done);
    }, function (error) {
        events.emit('progress', `Downloaded ${total} files`);

        events.emit('done', error);
    });

    return events;
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

    function copyFile(s3, content, iteratorCallback) {
        var relativePath = path.relative(oldFilePath, content.Key);

        function done(error) {
            if (error && error.code === 'NoSuchKey') return iteratorCallback(new BackupsError(BackupsError.NOT_FOUND, `Old backup not found: ${content.Key}`));
            if (error) {
                debug('copy: s3 copy error when copying %s %s', content.Key, error);
                return iteratorCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, `Error copying ${content.Key} : ${error.message} ${error.code}`));
            }

            iteratorCallback(null);
        }

        var copyParams = {
            Bucket: apiConfig.bucket,
            Key: path.join(newFilePath, relativePath)
        };

        // S3 copyObject has a file size limit of 5GB so if we have larger files, we do a multipart copy
        if (content.Size < 5 * 1024 * 1024 * 1024) {
            events.emit('progress', `Copying ${relativePath}`);

            copyParams.CopySource = encodeCopySource(apiConfig.bucket, content.Key);
            s3.copyObject(copyParams, done).on('retry', function (response) {
                ++retryCount;
                events.emit('progress', `Retrying (${response.retryCount+1}) copy of ${relativePath}. Status code: ${response.httpResponse.statusCode}`);
            });

            return;
        }

        events.emit('progress', `Copying (multipart) ${relativePath}`);

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
                    CopySource: encodeCopySource(apiConfig.bucket, content.Key), // See aws-sdk-js/issues/1302
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
                }).on('retry', function (response) {
                    ++retryCount;
                    events.emit('progress', `Retrying (${response.retryCount+1}) multipart copy of ${relativePath}. Status code: ${response.httpResponse.statusCode}`);
                });
            }

            copyNextChunk();
        });
    }

    var total = 0, concurrency = 4;

    listDir(apiConfig, oldFilePath, function (s3, objects, done) {
        total += objects.length;

        if (retryCount === 0) concurrency = Math.min(concurrency + 1, 10); else concurrency = Math.max(concurrency - 1, 5);
        events.emit('progress', `${retryCount} errors. concurrency set to ${concurrency}`);
        retryCount = 0;

        async.eachLimit(objects, concurrency, copyFile.bind(null, s3), done);
    }, function (error) {
        events.emit('progress', `Copied ${total} files`);

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
            if (error) debug(`remove: Unable to remove ${filename}. ${error.message}`);

            callback(error);
        });
    });
}

function removeDir(apiConfig, pathPrefix) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');

    var events = new EventEmitter();
    var total = 0;

    function deleteFiles(s3, contents, iteratorCallback) {
        var deleteParams = {
            Bucket: apiConfig.bucket,
            Delete: {
                Objects: contents.map(function (c) { return { Key: c.Key }; })
            }
        };

        events.emit('progress', `Removing ${contents.length} files from ${contents[0].Key} to ${contents[contents.length-1].Key}`);

        // deleteObjects does not return error if key is not found
        s3.deleteObjects(deleteParams, function (error /*, deleteData */) {
            if (error) {
                events.emit('progress', `Unable to remove ${contents.length} files from ${contents[0].Key} to ${contents[contents.length-1].Key}: ${error.message}`);
                return iteratorCallback(error);
            }

            iteratorCallback();
        });
    }

    listDir(apiConfig, pathPrefix, function (s3, objects, done) {
        total += objects.length;

        // digitalocean spaces takes too long to delete 1000 objects at a time
        const chunkSize = apiConfig.provider !== 'digitalocean-spaces' ? 1000 : 100;
        var chunks = chunk(objects, chunkSize);

        async.eachSeries(chunks, deleteFiles.bind(null, s3), done);
    }, function (error) {
        events.emit('progress', `Removed ${total} files`);

        events.emit('done', error);
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

function backupDone(apiConfig, backupId, appBackupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    if (apiConfig.provider !== 'caas') return callback();

    debug('[%s] backupDone: %s apps %j', backupId, backupId, appBackupIds);

    var url = config.apiServerOrigin() + '/api/v1/boxes/' + apiConfig.fqdn + '/backupDone';
    var data = {
        boxVersion: config.version(),
        backupId: backupId,
        appId: null,        // now unused
        appVersion: null,   // now unused
        appBackupIds: appBackupIds
    };

    superagent.post(url).send(data).query({ token: apiConfig.token }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));
        if (result.statusCode !== 200) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, result.text));

        return callback(null);
    });
}
