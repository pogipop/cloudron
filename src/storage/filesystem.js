'use strict';

exports = module.exports = {
    backup: backup,
    restore: restore,

    saveAppRestoreConfig: saveAppRestoreConfig,
    getAppRestoreConfig: getAppRestoreConfig,

    getDownloadStream: getDownloadStream,

    copyBackup: copyBackup,
    removeBackup: removeBackup,

    backupDone: backupDone,

    testConfig: testConfig
};

var assert = require('assert'),
    async = require('async'),
    BackupsError = require('../backups.js').BackupsError,
    debug = require('debug')('box:storage/filesystem'),
    fs = require('fs'),
    path = require('path'),
    mkdirp = require('mkdirp'),
    once = require('once'),
    safe = require('safetydance'),
    SettingsError = require('../settings.js').SettingsError,
    shell = require('../shell.js'),
    tar = require('tar-fs'),
    zlib = require('zlib'),
    archiver = require('archiver');

var FALLBACK_BACKUP_FOLDER = '/var/backups';
var RMBACKUP_CMD = path.join(__dirname, '../scripts/rmbackup.sh');

function backup(apiConfig, backupId, sourceDirectories, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(sourceDirectories));
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var backupFilePath = path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, backupId + '.tar.gz');

    debug('[%s] backup: %j -> %s', backupId, sourceDirectories, backupFilePath);

    mkdirp(path.dirname(backupFilePath), function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var fileStream = fs.createWriteStream(backupFilePath);
        var archive = archiver('tar', { gzip: true });

        fileStream.on('error', function (error) {
            console.error('[%s] backup: out stream error.', error);
        });

        archive.on('error', function (error) {
            console.error('[%s] backup: archive stream error.', error);
        });

        fileStream.on('close', function () {
            debug('[%s] backup: done.', backupId);
            callback();
        });

        archive.pipe(fileStream);
        sourceDirectories.forEach(function (directoryMap) {
            archive.directory(directoryMap.source, directoryMap.destination);
        });
        archive.finalize();
    });
}

function restore(apiConfig, backupId, destinationDirectories, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(destinationDirectories));
    assert.strictEqual(typeof callback, 'function');

    var sourceFilePath = path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, backupId + '.tar.gz');

    debug('[%s] restore: %s -> %j', backupId, sourceFilePath, destinationDirectories);

    if (!fs.existsSync(sourceFilePath)) return callback(new BackupsError(BackupsError.NOT_FOUND, 'backup file does not exist'));

    async.eachSeries(destinationDirectories, function (directory, callback) {
        debug('[%s] restore: directory %s -> %s', backupId, directory.source, directory.destination);

        mkdirp(directory.destination, function (error) {
            if (error) return callback(error);

            var fileStream = fs.createReadStream(sourceFilePath);
            var gunzipStream = zlib.createGunzip({});
            var extract = tar.extract(directory.destination);

            fileStream.on('error', function (error) {
                console.error('[%s] restore: file stream error.', error);
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

            fileStream.pipe(gunzipStream).pipe(extract);
        });
    }, function (error) {
        if (error) return callback(error);

        debug('[%s] restore: done', backupId);

        callback();
    });
}

function getDownloadStream(apiConfig, backupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var backupFilePath = path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, backupId);

    debug('[%s] getDownloadStream: %s %s', backupId, backupId, backupFilePath);

    if (!fs.existsSync(backupFilePath)) return callback(new BackupsError(BackupsError.NOT_FOUND, 'backup file does not exist'));

    var stream = fs.createReadStream(backupFilePath);
    callback(null, stream);
}

function saveAppRestoreConfig(apiConfig, backupId, restoreConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof restoreConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    var backupFilePath = path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, backupId + '.json');

    debug('[%s] saveAppRestoreConfig: %j -> %s', backupId, restoreConfig, backupFilePath);

    mkdirp(path.dirname(backupFilePath), function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        fs.writeFile(backupFilePath, JSON.stringify(restoreConfig), function (error) {
            if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

            debug('[%s] saveAppRestoreConfig: done', backupId);

            callback();
        });
    });
}

function getAppRestoreConfig(apiConfig, backupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var sourceFilePath = path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, backupId + '.json');

    debug('[%s] getAppRestoreConfig: %s', backupId, sourceFilePath);

    if (!fs.existsSync(sourceFilePath)) return callback(new BackupsError(BackupsError.NOT_FOUND, 'restore config file does not exist'));

    var restoreConfig = safe.require(sourceFilePath);
    if (!restoreConfig) {
        console.error('[%s] getAppRestoreConfig: failed', safe.error);
        return callback(new BackupsError(BackupsError.INTERNAL_ERROR, safe.error));
    }

    callback(null, restoreConfig);
}

function copyBackup(apiConfig, oldBackupId, newBackupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldBackupId, 'string');
    assert.strictEqual(typeof newBackupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var oldBackupFilePath = path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, oldBackupId + '.tar.gz');
    var newBackupFilePath = path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, newBackupId + '.tar.gz');

    // FIXME this most likely has a permissions issue as this process runs as yellowtent not root
    mkdirp(path.dirname(newBackupFilePath), function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var readStream = fs.createReadStream(oldBackupFilePath);
        var writeStream = fs.createWriteStream(newBackupFilePath);

        readStream.on('error', callback);
        writeStream.on('error', callback);
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
        var filePath = path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, id + '.tar.gz');

        shell.sudo('deleteBackup', [ RMBACKUP_CMD, filePath ], function (error) {
            if (error) console.error('Unable to remove %s. Not fatal.', filePath, safe.error);
            callback();
        });
    }, callback);
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
