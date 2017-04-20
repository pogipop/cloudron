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

var assert = require('assert'),
    async = require('async'),
    BackupsError = require('../backups.js').BackupsError,
    crypto = require('crypto'),
    debug = require('debug')('box:storage/filesystem'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    once = require('once'),
    path = require('path'),
    SettingsError = require('../settings.js').SettingsError,
    tar = require('tar-fs'),
    zlib = require('zlib');

var FALLBACK_BACKUP_FOLDER = '/var/backups';
var FILE_TYPE = '.tar.gz';

// internal only
function getBackupFilePath(apiConfig, backupId) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');

    return path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, backupId.endsWith(FILE_TYPE) ? backupId : backupId+FILE_TYPE);
}

// storage api
function backup(apiConfig, backupId, source, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof source, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    // to allow setting 776 for real
    var oldUmask = process.umask(0);
    var oldCallback = callback;
    callback = function (error) {
        process.umask(oldUmask);
        oldCallback(error);
    };

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] backup: %s -> %s', backupId, source, backupFilePath);

    mkdirp(path.dirname(backupFilePath), { mode: 0o777 }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var pack = tar.pack(source);
        var gzip = zlib.createGzip({});
        var encrypt = crypto.createCipher('aes-256-cbc', apiConfig.key || '');
        var fileStream = fs.createWriteStream(backupFilePath, { mode: 0o776 });

        pack.on('error', function (error) {
            console.error('[%s] backup: tar stream error.', backupId, error);
        });

        gzip.on('error', function (error) {
            console.error('[%s] backup: gzip stream error.', backupId, error);
        });

        encrypt.on('error', function (error) {
            console.error('[%s] backup: encrypt stream error.', backupId, error);
        });

        fileStream.on('error', function (error) {
            console.error('[%s] backup: out stream error.', backupId, error);
        });

        fileStream.on('close', function () {
            debug('[%s] backup: done.', backupId);
            callback(null);
        });

        pack.pipe(gzip).pipe(encrypt).pipe(fileStream);
    });
}

function restore(apiConfig, backupId, destination, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof callback, 'function');

    var sourceFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] restore: %s -> %s', backupId, sourceFilePath, destination);

    if (!fs.existsSync(sourceFilePath)) return callback(new BackupsError(BackupsError.NOT_FOUND, 'backup file does not exist'));

    mkdirp(destination, function (error) {
        if (error) return callback(error);

        var fileStream = fs.createReadStream(sourceFilePath);
        var decipher = crypto.createDecipher('aes-256-cbc', apiConfig.key || '');
        var gunzip = zlib.createGunzip({});
        var extract = tar.extract(destination);

        fileStream.on('error', function (error) {
            console.error('[%s] restore: file stream error.', error);
            callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));
        });

        decipher.on('error', function (error) {
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
            debug('[%s] restore: %s done.', backupId);
            callback();
        });

        fileStream.pipe(decipher).pipe(gunzip).pipe(extract);
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

    debug('copyBackup: %s -> %s', oldFilePath, newFilePath);

    // to allow setting 776 for real
    var oldUmask = process.umask(0);
    var oldCallback = callback;
    callback = function (error) {
        process.umask(oldUmask);
        oldCallback(error);
    };

    mkdirp(path.dirname(newFilePath), { mode: 0o777 }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var readStream = fs.createReadStream(oldFilePath);
        var writeStream = fs.createWriteStream(newFilePath);

        readStream.on('error', function (error) {
            console.error('copyBackup: read stream error.', error);
            callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));
        });

        writeStream.on('error', function (error) {
            console.error('copyBackup: write stream error.', error);
            callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));
        });

        writeStream.on('close', callback);

        readStream.pipe(writeStream);
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
            if (error) console.error('Unable to remove %s. Not fatal.', filePath, error);
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
