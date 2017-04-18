'use strict';

exports = module.exports = {
    backup: backup,
    restore: restore,
    copyBackup: copyBackup,
    removeBackup: removeBackup,

    getDownloadStream: getDownloadStream,

    backupDone: backupDone,

    testConfig: testConfig
};

var archiver = require('archiver'),
    assert = require('assert'),
    async = require('async'),
    AWS = require('aws-sdk'),
    BackupsError = require('../backups.js').BackupsError,
    crypto = require('crypto'),
    debug = require('debug')('box:storage/s3'),
    mkdirp = require('mkdirp'),
    once = require('once'),
    path = require('path'),
    SettingsError = require('../settings.js').SettingsError,
    shell = require('../shell.js'),
    tar = require('tar-fs'),
    zlib = require('zlib');

var FILE_TYPE = '.tar.gz';

// internal only
function getBackupCredentials(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    assert(apiConfig.accessKeyId && apiConfig.secretAccessKey);

    var credentials = {
        signatureVersion: 'v4',
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
        s3.upload(params, function (error, result) {
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
                    if (error.code === 'NoSuchKey') return callback(new BackupsError(BackupsError.NOT_FOUND));

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
        s3.copyObject(params, function (error, result) {
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

    // Result: none

    callback(new Error('not implemented'));
}

function getDownloadStream(apiConfig, backupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] getDownloadStream: %s %s', backupId, backupId, backupFilePath);

    callback(new Error('not implemented'));
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (typeof apiConfig.accessKeyId !== 'string') return callback(new SettingsError(SettingsError.BAD_FIELD, 'accessKeyId must be a string'));
    if (typeof apiConfig.secretAccessKey !== 'string') return callback(new SettingsError(SettingsError.BAD_FIELD, 'secretAccessKey must be a string'));
    if (typeof apiConfig.bucket !== 'string') return callback(new SettingsError(SettingsError.BAD_FIELD, 'bucket must be a string'));
    if (typeof apiConfig.prefix !== 'string') return callback(new SettingsError(SettingsError.BAD_FIELD, 'prefix must be a string'));

    // attempt to upload and delete a file with new credentials
    // First use the javascript api, to get better feedback, then use aws cli tool
    // The javascript api always autodetects the correct settings, regardless of the region provided, the cli tool does not
    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var params = {
            Bucket: apiConfig.bucket,
            Key: apiConfig.prefix + '/testfile',
            Body: 'testcontent'
        };

        var s3 = new AWS.S3(credentials);
        s3.putObject(params, function (error) {
            if (error) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, error.message));

            var params = {
                Bucket: apiConfig.bucket,
                Key: apiConfig.prefix + '/testfile'
            };

            s3.deleteObject(params, function (error) {
                if (error) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, error.message));

                // now perform the same as what we do in the backup shell scripts
                var BACKUP_TEST_CMD = require('path').join(__dirname, '../scripts/backuptests3.sh');
                var tmpUrl = 's3://' + apiConfig.bucket + '/' + apiConfig.prefix + '/testfile';
                var args = [ tmpUrl, credentials.accessKeyId, credentials.secretAccessKey, credentials.region, credentials.endpoint || '' ];

                // if this fails the region is wrong, otherwise we would have failed earlier.
                shell.exec('backupTestS3', BACKUP_TEST_CMD, args, function (error) {
                    if (error) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, 'Wrong region'));

                    callback();
                });
            });
        });
    });
}

function backupDone(filename, app, appBackupIds, callback) {
    assert.strictEqual(typeof filename, 'string');
    assert(!app || typeof app === 'object');
    assert(!appBackupIds || Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback();
}
