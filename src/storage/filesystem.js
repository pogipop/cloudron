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
    BackupsError = require('../backups.js').BackupsError,
    crypto = require('crypto'),
    debug = require('debug')('box:storage/filesystem'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    once = require('once'),
    path = require('path'),
    safe = require('safetydance'),
    SettingsError = require('../settings.js').SettingsError,
    tar = require('tar-fs'),
    zlib = require('zlib');

var FALLBACK_BACKUP_FOLDER = '/var/backups';
var FILE_TYPE = '.tar.gz';

// internal only
function copyFile(source, destination, callback) {
    callback = once(callback);

    // not run as root, permissions are fine
    var readStream = fs.createReadStream(source);
    var writeStream = fs.createWriteStream(destination);

    readStream.on('error', callback);
    writeStream.on('error', callback);
    writeStream.on('close', callback);

    readStream.pipe(writeStream);
}

function getBackupFilePath(apiConfig, backupId) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');

    return path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, backupId.endsWith(FILE_TYPE) ? backupId : backupId+FILE_TYPE);
}

// storage api
function backup(apiConfig, backupId, sourceDirectories, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(sourceDirectories));
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    // to allow setting 777 for real
    var oldUmask = process.umask(0);
    var oldCallback = callback;
    callback = function (error) {
        process.umask(oldUmask);
        oldCallback(error);
    };

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] backup: %j -> %s', backupId, sourceDirectories, backupFilePath);

    mkdirp(path.dirname(backupFilePath), { mode: 0o777 }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var fileStream = fs.createWriteStream(backupFilePath, { mode: 0o777 });
        var archive = archiver('tar', { gzip: true });
        var cipher = crypto.createCipher('aes-256-cbc', apiConfig.key || '');

        fileStream.on('error', function (error) {
            console.error('[%s] backup: out stream error.', backupId, error);
        });

        cipher.on('error', function (error) {
            console.error('[%s] backup: cipher stream error.', backupId, error);
        });

        archive.on('error', function (error) {
            console.error('[%s] backup: archive stream error.', backupId, error);
        });

        fileStream.on('close', function () {
            debug('[%s] backup: done.', backupId);
            callback(null);
        });

        archive.pipe(cipher).pipe(fileStream);

        sourceDirectories.forEach(function (directory) {
            // archive does not like destination beginning with a slash
            directory.destination = path.normalize(directory.destination).replace(/^\//, '');

            archive.directory(directory.source, directory.destination);
        });

        archive.finalize();
    });
}

function restore(apiConfig, backupId, destinationDirectories, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(destinationDirectories));
    assert.strictEqual(typeof callback, 'function');

    var sourceFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] restore: %s -> %j', backupId, sourceFilePath, destinationDirectories);

    if (!fs.existsSync(sourceFilePath)) return callback(new BackupsError(BackupsError.NOT_FOUND, 'backup file does not exist'));

    async.eachSeries(destinationDirectories, function (directory, callback) {
        debug('[%s] restore: directory %s -> %s', backupId, directory.source, directory.destination);

        // tar-fs reports without slash at the beginning
        directory.source = path.normalize(directory.source).replace(/^\//, '');

        mkdirp(directory.destination, function (error) {
            if (error) return callback(error);

            var fileStream = fs.createReadStream(sourceFilePath);
            var decipher = crypto.createDecipher('aes-256-cbc', apiConfig.key || '');
            var gunzipStream = zlib.createGunzip({});

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

            fileStream.on('error', function (error) {
                console.error('[%s] restore: file stream error.', error);
                callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));
            });

            decipher.on('error', function (error) {
                console.error('[%s] restore: decipher stream error.', error);
                callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));
            });

            gunzipStream.on('error', function (error) {
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

            fileStream.pipe(decipher).pipe(gunzipStream).pipe(extract);
        });
    }, function (error) {
        if (error) return callback(error);

        debug('[%s] restore: done', backupId);

        callback(null);
    });
}

function copyBackup(apiConfig, oldBackupId, newBackupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldBackupId, 'string');
    assert.strictEqual(typeof newBackupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var oldFilePath = getBackupFilePath(apiConfig, oldBackupId);
    var newFilePath = getBackupFilePath(apiConfig, newBackupId);

    copyFile(oldFilePath, newFilePath, function (error) {
        if (error) {
            console.error('Unable to copy backup %s -> %s.', oldFilePath, newFilePath, error);
            return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));
        }

        callback();
    });
}

function removeBackup(apiConfig, backupId, appBackupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    async.each([backupId].concat(appBackupIds), function (id, callback) {
        var filePath = getBackupFilePath(apiConfig, id);

        fs.unlink(filePath, function (error) {
            if (error) console.error('Unable to remove %s. Not fatal.', filePath, safe.error);
            callback();
        });
    }, callback);
}

function getDownloadStream(apiConfig, backupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] getDownloadStream: %s %s', backupId, backupId, backupFilePath);

    if (!fs.existsSync(backupFilePath)) return callback(new BackupsError(BackupsError.NOT_FOUND, 'backup file does not exist'));

    var stream = fs.createReadStream(backupFilePath);
    callback(null, stream);
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (typeof apiConfig.backupFolder !== 'string') return callback(new SettingsError(SettingsError.BAD_FIELD, 'backupFolder must be string'));

    callback();
}

function backupDone(filename, app, appBackupIds, callback) {
    assert.strictEqual(typeof filename, 'string');
    assert(!app || typeof app === 'object');
    assert(!appBackupIds || Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback();
}
