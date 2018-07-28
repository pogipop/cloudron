'use strict';

exports = module.exports = {
    upload: upload,
    download: download,
    copy: copy,

    listDir: listDir,

    remove: remove,
    removeDir: removeDir,

    testConfig: testConfig,

    // Used to mock GCS
    _mockInject: mockInject,
    _mockRestore: mockRestore
};

var assert = require('assert'),
    async = require('async'),
    BackupsError = require('../backups.js').BackupsError,
    debug = require('debug')('box:storage/gcs'),
    EventEmitter = require('events'),
    GCS = require('@google-cloud/storage'),
    PassThrough = require('stream').PassThrough,
    path = require('path');

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
function getBucket(apiConfig) {
    assert.strictEqual(typeof apiConfig, 'object');

    var gcsConfig = {
        projectId: apiConfig.projectId,

        credentials: {
            client_email: apiConfig.credentials.client_email,
            private_key: apiConfig.credentials.private_key
        }
    };

    return GCS(gcsConfig).bucket(apiConfig.bucket);
}

// storage api
function upload(apiConfig, backupFilePath, sourceStream, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof sourceStream, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug(`Uploading to ${backupFilePath}`);

    function done(error) {
        if (error) {
            debug('[%s] upload: gcp upload error.', backupFilePath, error);
            return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, `Error uploading ${backupFilePath}. Message: ${error.message} HTTP Code: ${error.code}`));
        }

        callback(null);
    }

    var uploadStream = getBucket(apiConfig).file(backupFilePath)
        .createWriteStream({resumable: false})
        .on('finish', done)
        .on('error', done);

    sourceStream.pipe(uploadStream);
}

function download(apiConfig, backupFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`Download ${backupFilePath} starting`);

    var file = getBucket(apiConfig).file(backupFilePath);

    var ps = new PassThrough();
    var readStream = file.createReadStream()
        .on('error', function(error) {
            if (error && error.code == 404){
                ps.emit('error', new BackupsError(BackupsError.NOT_FOUND));
            } else {
                debug('[%s] download: gcp stream error.', backupFilePath, error);
                ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error));
            }
        })
    ;
    readStream.pipe(ps);

    callback(null, ps);
}

function listDir(apiConfig, backupFilePath, batchSize, iteratorCallback, callback) {
    var bucket = getBucket(apiConfig);

    var query = { prefix: backupFilePath, autoPaginate: batchSize === -1 };
    if (batchSize > 0) {
        query.maxResults = batchSize;
    }

    async.forever(function listAndDownload(foreverCallback) {
        bucket.getFiles(query, function (error, files, nextQuery) {
            if (error) return foreverCallback(error);

            if (files.length === 0) return foreverCallback(new Error('Done'));

            const entries = files.map(function (f) { return { fullPath: f.name }; });
            iteratorCallback(entries, function (error) {
                if (error) return foreverCallback(error);
                if (!nextQuery) return foreverCallback(new Error('Done'));

                query = nextQuery;

                foreverCallback();
            });
        });
    }, function (error) {
        if (error.message === 'Done') return callback(null);

        callback(error);
    });
}

function copy(apiConfig, oldFilePath, newFilePath) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');

    var events = new EventEmitter(), retryCount = 0;

    function copyFile(entry, iteratorCallback) {
        var relativePath = path.relative(oldFilePath, entry.fullPath);

        getBucket(apiConfig).file(entry.fullPath).copy(path.join(newFilePath, relativePath), function(error) {
            if (error) debug('copyBackup: gcs copy error', error);

            if (error && error.code === 404) return iteratorCallback(new BackupsError(BackupsError.NOT_FOUND, 'Old backup not found'));
            if (error) return iteratorCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

            iteratorCallback(null);
        });

        events.emit('progress', `Copying ${relativePath}...`);
    }

    const batchSize = -1;
    var total = 0, concurrency = 4;

    listDir(apiConfig, oldFilePath, batchSize, function (entries, done) {
        total += entries.length;

        if (retryCount === 0) concurrency = Math.min(concurrency + 1, 10); else concurrency = Math.max(concurrency - 1, 5);
        events.emit('progress', `${retryCount} errors. concurrency set to ${concurrency}`);
        retryCount = 0;

        async.eachLimit(entries, concurrency, copyFile, done);
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

    getBucket(apiConfig)
        .file(filename)
        .delete(function (error) {
            if (error) debug('removeBackups: Unable to remove %s (%s). Not fatal.', filename, error.message);

            callback(null);
        });
}

function removeDir(apiConfig, pathPrefix) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');

    var events = new EventEmitter(), retryCount = 0;

    const batchSize = 1;
    var total = 0, concurrency = 4;

    listDir(apiConfig, pathPrefix, batchSize, function (entries, done) {
        total += entries.length;

        if (retryCount === 0) concurrency = Math.min(concurrency + 1, 10); else concurrency = Math.max(concurrency - 1, 5);
        events.emit('progress', `${retryCount} errors. concurrency set to ${concurrency}`);
        retryCount = 0;

        async.eachLimit(entries, concurrency, function (entry, iteratorCallback) {
            remove(apiConfig, entry.fullPath, iteratorCallback);
        }, done);
    }, function (error) {
        events.emit('progress', `Deleted ${total} files`);

        events.emit('done', error);
    });

    return events;
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (typeof apiConfig.projectId !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'projectId must be a string'));
    if (!apiConfig.credentials || typeof apiConfig.credentials !== 'object') return callback(new BackupsError(BackupsError.BAD_FIELD, 'credentials must be an object'));
    if (typeof apiConfig.credentials.client_email !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'credentials.client_email must be a string'));
    if (typeof apiConfig.credentials.private_key !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'credentials.private_key must be a string'));

    if (typeof apiConfig.bucket !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'bucket must be a string'));
    if (typeof apiConfig.prefix !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'prefix must be a string'));

    // attempt to upload and delete a file with new credentials
    var bucket = getBucket(apiConfig);

    var testFile = bucket.file(path.join(apiConfig.prefix, 'cloudron-testfile'));

    var uploadStream = testFile.createWriteStream({ resumable: false });
    uploadStream.write('testfilecontents');
    uploadStream.end();

    uploadStream.on('error', function(error) {
        debug('testConfig: failed uploading cloudron-testfile', error);
        if (error && error.code && (error.code == 403 || error.code == 404)) {
            return callback(new BackupsError(BackupsError.BAD_FIELD, error.message));
        }

        return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    uploadStream.on('finish', function() {
        debug('testConfig: uploaded cloudron-testfile ' + JSON.stringify(arguments));
        bucket.file(path.join(apiConfig.prefix, 'cloudron-testfile')).delete(function(error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
            debug('testConfig: deleted cloudron-testfile');
            callback();
        });
    });
}

