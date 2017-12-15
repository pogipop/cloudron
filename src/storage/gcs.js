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

    // Used to mock GCS
    _mockInject: mockInject,
    _mockRestore: mockRestore
};

var assert = require('assert'),
    async = require('async'),
    BackupsError = require('../backups.js').BackupsError,
    debug = require('debug')('box:storage/gcs'),
    EventEmitter = require('events'),
    fs = require('fs'),
    GCS = require('@google-cloud/storage'),
    mkdirp = require('mkdirp'),
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

    return sourceStream.pipe(
        getBucket(apiConfig)
            .file(backupFilePath)
            .createWriteStream({resumable: false})
                .on('finish', done)
                .on('error', function(e){
                    if (e) done(e);
                })
    );
}

function download(apiConfig, backupFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`Download ${backupFilePath} starting`);

    var file = getBucket(apiConfig).file(backupFilePath);

    var ps = new PassThrough();
    var readStream = file.createReadStream()
        .on('error', function(error){
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

function listDir(apiConfig, backupFilePath, batchSize, iteratorCallback, callback){
    var bucket = getBucket(apiConfig);

    var query = {prefix: backupFilePath, autoPaginate: batchSize === -1};
    if (batchSize > 0) {
        query.maxResults = batchSize;
    }

    async.forever(function listAndDownload(foreverCallback) {
        bucket.getFiles(query, function (error, files, nextQuery) {
            if (error) {
                debug('remove: Failed to list %s. Not fatal.', error);
                return foreverCallback(error);
            }

            if (files.length === 0) return foreverCallback(new Error('Done'));

            debug('emitting '+files.length+' files found: ' + files.map(function(f){return f.name}).join(','));
            iteratorCallback(files, function (error) {
                if (error) {
                    debug(`listDir page handled unsuccessfully ${error}`);
                    return foreverCallback(error);
                }

                if (!nextQuery) return foreverCallback(new Error('Done'));

                query = nextQuery;
                debug(`listDir next page token ${query.pageToken}`);
                foreverCallback();
            });
        });
    }, function (error) {
        if (error.message === 'Done') return callback(null);

        callback(error);
    });
}

function downloadDir(apiConfig, backupFilePath, destDir) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof destDir, 'string');

    var events = new EventEmitter();
    var total = 0;

    function downloadFile(file, iteratorCallback) {
        var relativePath = path.relative(backupFilePath, file.name);

        events.emit('progress', `Downloading ${relativePath}`);

        mkdirp(path.dirname(path.join(destDir, relativePath)), function (error) {
            if (error) return iteratorCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

            download(apiConfig, file.name, function (error, sourceStream) {
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

    const concurrency = 10, batchSize = -1;

    listDir(apiConfig, backupFilePath, batchSize, function (files, done) {
        total += files.length;
        async.eachLimit(files, concurrency, downloadFile, done);
    }, function (error) {
        events.emit('progress', `Downloaded ${total} files`);
        events.emit('done', error);
    });

    return events;
}

function copy(apiConfig, oldFilePath, newFilePath) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');

    var events = new EventEmitter(), retryCount = 0;

    function copyFile(file, iteratorCallback){

        var relativePath = path.relative(oldFilePath, file.name);

        file.copy(path.join(newFilePath, relativePath), function(error, newFile, apiResponse){
            if (error && error.code == 404) return iteratorCallback(new BackupsError(BackupsError.NOT_FOUND, 'Old backup not found'));
            if (error) {
                debug('copyBackup: gcs copy error', error);
                return iteratorCallback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
            }
            iteratorCallback(null);
        });

        events.emit('progress', `Copying ${relativePath}...`);
    }

    const batchSize = -1;
    var total = 0, concurrency = 4;

    listDir(apiConfig, oldFilePath, batchSize, function (files, done) {
        total += files.length;

        if (retryCount === 0) concurrency = Math.min(concurrency + 1, 10); else concurrency = Math.max(concurrency - 1, 5);
        events.emit('progress', `${retryCount} errors. concurrency set to ${concurrency}`);
        retryCount = 0;

        async.eachLimit(files, concurrency, copyFile, done);
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
        .delete(function(e){
            if (e) debug('removeBackups: Unable to remove %s (%s). Not fatal.', filename, e.message);
            else debug('removeBackups: Deleted: %s', filename);
            callback(null);
        });
}

function removeDir(apiConfig, pathPrefix) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');

    var events = new EventEmitter(), retryCount = 0;

    const batchSize = 1;
    var total = 0, concurrency = 4;

    listDir(apiConfig, pathPrefix, batchSize, function (files, done) {
        total += files.length;

        if (retryCount === 0) concurrency = Math.min(concurrency + 1, 10); else concurrency = Math.max(concurrency - 1, 5);
        events.emit('progress', `${retryCount} errors. concurrency set to ${concurrency}`);
        retryCount = 0;

        async.eachLimit(files, concurrency, remove.bind(null, apiConfig), done);
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

    var uploadStream = testFile.createWriteStream({resumable: false})
        .on('error', function(error){
            debug('uploadStream failed uploading cloudron-testfile', error);
            if (error && error.code && (error.code == 403 || error.code == 404)){
                callback(new BackupsError(BackupsError.BAD_FIELD, error.message));
            }

            return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        })
    ;

    var testfileStream = new PassThrough();
    testfileStream.write("testfilecontents");
    testfileStream.end();

    testfileStream
        .on('end', function(){
            debug('uploadStream uploaded cloudron-testfile '+JSON.stringify(arguments));
            testFile.delete(function(error){
                if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
                debug('testFileStream deleted cloudron-testfile');
                callback();
            });
        })
        .pipe(uploadStream);
}

function backupDone(apiConfig, backupId, appBackupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback();
}
