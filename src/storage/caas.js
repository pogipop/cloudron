'use strict';

exports = module.exports = {
    backup: backup,
    restore: restore,
    copyBackup: copyBackup,
    removeBackup: removeBackup,

    getDownloadStream: getDownloadStream,

    backupDone: backupDone,

    testConfig: testConfig,
};

var archiver = require('archiver'),
    assert = require('assert'),
    async = require('async'),
    AWS = require('aws-sdk'),
    BackupsError = require('../backups.js').BackupsError,
    config = require('../config.js'),
    crypto = require('crypto'),
    debug = require('debug')('box:storage/caas'),
    mkdirp = require('mkdirp'),
    once = require('once'),
    path = require('path'),
    superagent = require('superagent'),
    tar = require('tar-fs'),
    zlib = require('zlib');

var FILE_TYPE = '.tar.gz';

// internal only
function getBackupCredentials(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');
    assert(apiConfig.token);

    var url = config.apiServerOrigin() + '/api/v1/boxes/' + config.fqdn() + '/awscredentials';
    superagent.post(url).query({ token: apiConfig.token }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(error);
        if (result.statusCode !== 201) return callback(new Error(result.text));
        if (!result.body || !result.body.credentials) return callback(new Error('Unexpected response'));

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

        var archive = archiver('tar', { gzip: true });
        var encrypt = crypto.createCipher('aes-256-cbc', apiConfig.key || '');

        encrypt.on('error', function (error) {
            console.error('[%s] backup: cipher stream error.', backupId, error);
        });

        archive.on('error', function (error) {
            console.error('[%s] backup: archive stream error.', backupId, error);
        });

        archive.pipe(encrypt);

        sourceDirectories.forEach(function (directory) {
            // archive does not like destination beginning with a slash
            directory.destination = path.normalize(directory.destination).replace(/^\//, '');

            archive.directory(directory.source, directory.destination);
        });

        archive.finalize();

        var params = {
            Bucket: apiConfig.bucket,
            Key: backupFilePath,
            Body: encrypt
        };

        var s3 = new AWS.S3(credentials);
        s3.upload(params, function (error) {
            if (error) {
                console.error('[%s] backup: s3 upload error.', backupId, error);
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));
            }

            callback(null);
        });
    });
}

function restore(apiConfig, backupId, destinationDirectories, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(destinationDirectories));
    assert.strictEqual(typeof callback, 'function');

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] restore: %s -> %j', backupId, backupFilePath, destinationDirectories);

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        async.eachSeries(destinationDirectories, function (directory, callback) {
            debug('[%s] restore: directory %s -> %s', backupId, directory.source, directory.destination);

            // tar-fs reports without slash at the beginning
            directory.source = path.normalize(directory.source).replace(/^\//, '');

            mkdirp(directory.destination, function (error) {
                if (error) return callback(error);

                var params = {
                    Bucket: apiConfig.bucket,
                    Key: backupFilePath
                };

                var s3 = new AWS.S3(credentials);

                var s3get = s3.getObject(params).createReadStream();
                var decrypt = crypto.createDecipher('aes-256-cbc', apiConfig.key || '');
                var gunzip = zlib.createGunzip({});

                var IGNORE_PREFIX = '__ignore__';
                var extract = tar.extract(directory.destination, {
                    ignore: function (name, header) { return header.name.startsWith(IGNORE_PREFIX); },
                    map: function (header) {
                        // ignore is called after map, we mark everything we dont want!
                        // else slice off the mapping prefix
                        if (!header.name.startsWith(directory.source)) header.name = IGNORE_PREFIX + header.name;
                        else header.name = header.name.slice(directory.source.length);

                        return header;
                    }
                });

                s3get.on('error', function (error) {
                    // TODO ENOENT for the mock, fix upstream!
                    if (error.code === 'NoSuchKey' || error.code === 'ENOENT') return callback(new BackupsError(BackupsError.NOT_FOUND));

                    console.error('[%s] restore: s3 stream error.', backupId, error);
                    callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));
                });

                decrypt.on('error', function (error) {
                    console.error('[%s] restore: decipher stream error.', error);
                    callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));
                });

                gunzip.on('error', function (error) {
                    console.error('[%s] restore: gunzip stream error.', error);
                    callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));
                });

                extract.on('error', function (error) {
                    console.error('[%s] restore: extract stream error.', error);
                    callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));
                });

                extract.on('finish', function () {
                    debug('[%s] restore: directory %s done.', backupId, directory.source);
                    callback();
                });

                s3get.pipe(decrypt).pipe(gunzip).pipe(extract);
            });
        }, function (error) {
            if (error) return callback(error);

            debug('[%s] restore: done', backupId);

            callback(null);
        });
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
                console.error('copyBackup: s3 copy error.', error);
                return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));
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

function getDownloadStream(apiConfig, backupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] getDownloadStream: %s %s', backupId, backupId, backupFilePath);

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key: backupFilePath
        };

        var s3 = new AWS.S3(credentials);

        s3.headObject(params, function (error) {
            // TODO ENOENT for the mock, fix upstream!
            if (error && (error.code === 'NotFound' || error.code === 'ENOENT')) return callback(new BackupsError(BackupsError.NOT_FOUND));
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));

            var s3get = s3.getObject(params).createReadStream();
            var decrypt = crypto.createDecipher('aes-256-cbc', apiConfig.key || '');

            s3get.on('error', function (error) {
                if (error.code === 'NoSuchKey') return callback(new BackupsError(BackupsError.NOT_FOUND));

                console.error('[%s] getDownloadStream: s3 stream error.', backupId, error);
                callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));
            });

            decrypt.on('error', function (error) {
                console.error('[%s] getDownloadStream: decipher stream error.', error);
                callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));
            });

            s3get.pipe(decrypt);

            callback(null, decrypt);
        });
    });
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (config.provider() !== 'caas') return callback(new BackupsError(BackupsError.BAD_FIELD, 'instance provider must be caas'));

    callback();
}

function backupDone(filename, app, appBackupIds, callback) {
    assert.strictEqual(typeof filename, 'string');
    assert(!app || typeof app === 'object');
    assert(!appBackupIds || Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    debug('backupDone %s', filename);

    var url = config.apiServerOrigin() + '/api/v1/boxes/' + config.fqdn() + '/backupDone';
    var data = {
        boxVersion: config.version(),
        restoreKey: filename,
        appId: app ? app.id : null,
        appVersion: app ? app.manifest.version : null,
        appBackupIds: appBackupIds
    };

    superagent.post(url).send(data).query({ token: config.token() }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(error);
        if (result.statusCode !== 200) return callback(new Error(result.text));
        if (!result.body) return callback(new Error('Unexpected response'));

        return callback(null);
    });
}
