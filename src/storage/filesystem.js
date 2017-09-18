'use strict';

exports = module.exports = {
    upload: upload,
    download: download,
    copy: copy,

    removeMany: removeMany,

    backupDone: backupDone,

    testConfig: testConfig
};

var assert = require('assert'),
    async = require('async'),
    BackupsError = require('../backups.js').BackupsError,
    config = require('../config.js'),
    debug = require('debug')('box:storage/filesystem'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    once = require('once'),
    path = require('path'),
    safe = require('safetydance'),
    targz = require('./targz.js');

var FALLBACK_BACKUP_FOLDER = '/var/backups';
var BACKUP_USER = config.TEST ? process.env.USER : 'yellowtent';

// internal only
function getBackupFilePath(apiConfig, backupId) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');

    const FILE_TYPE = apiConfig.key ? '.tar.gz.enc' : '.tar.gz';

    return path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, backupId.endsWith(FILE_TYPE) ? backupId : backupId+FILE_TYPE);
}

// storage api
function upload(apiConfig, backupId, sourceDir, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof sourceDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] backup: %s -> %s', backupId, sourceDir, backupFilePath);

    mkdirp(path.dirname(backupFilePath), function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        var fileStream = fs.createWriteStream(backupFilePath);

        fileStream.on('error', function (error) {
            debug('[%s] backup: out stream error.', backupId, error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        fileStream.on('close', function () {
            debug('[%s] backup: changing ownership.', backupId);

            if (!safe.child_process.execSync('chown -R ' + BACKUP_USER + ':' + BACKUP_USER + ' ' + path.dirname(backupFilePath))) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, safe.error.message));

            debug('[%s] backup: done.', backupId);

            callback(null);
        });

        targz.create(sourceDir, apiConfig.key || null, fileStream, callback);
    });
}

function download(apiConfig, backupId, destination, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var sourceFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] restore: %s -> %s', backupId, sourceFilePath, destination);

    if (!fs.existsSync(sourceFilePath)) return callback(new BackupsError(BackupsError.NOT_FOUND, 'backup file does not exist'));

    var fileStream = fs.createReadStream(sourceFilePath);

    fileStream.on('error', function (error) {
        debug('restore: file stream error.', error);
        callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    targz.extract(fileStream, destination, apiConfig.key || null, callback);
}

function copy(apiConfig, oldBackupId, newBackupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldBackupId, 'string');
    assert.strictEqual(typeof newBackupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var oldFilePath = getBackupFilePath(apiConfig, oldBackupId);
    var newFilePath = getBackupFilePath(apiConfig, newBackupId);

    debug('copy: %s -> %s', oldFilePath, newFilePath);

    mkdirp(path.dirname(newFilePath), function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        var readStream = fs.createReadStream(oldFilePath);
        var writeStream = fs.createWriteStream(newFilePath);

        readStream.on('error', function (error) {
            debug('copyBackup: read stream error.', error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        writeStream.on('error', function (error) {
            debug('copyBackup: write stream error.', error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        writeStream.on('close', function () {
            if (!safe.child_process.execSync('chown -R ' + BACKUP_USER + ':' + BACKUP_USER + ' ' + path.dirname(newFilePath))) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, safe.error.message));

            callback();
        });

        readStream.pipe(writeStream);
    });
}

function removeMany(apiConfig, backupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert(Array.isArray(backupIds));
    assert.strictEqual(typeof callback, 'function');

    async.eachSeries(backupIds, function (id, iteratorCallback) {
        var filePath = getBackupFilePath(apiConfig, id);

        if (!safe.fs.unlinkSync(filePath)) {
            debug('removeMany: Unable to remove %s : %s', filePath, safe.error.message);
        }

        safe.fs.rmdirSync(path.dirname(filePath)); // try to cleanup empty directories

        iteratorCallback();
    }, callback);
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if ('backupFolder' in apiConfig && typeof apiConfig.backupFolder !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'backupFolder must be string'));

    // default value will be used
    if (!apiConfig.backupFolder) return callback();

    fs.stat(apiConfig.backupFolder, function (error, result) {
        if (error) {
            debug('testConfig: %s', apiConfig.backupFolder, error);
            return callback(new BackupsError(BackupsError.BAD_FIELD, 'Directory does not exist or cannot be accessed'));
        }

        if (!result.isDirectory()) return callback(new BackupsError(BackupsError.BAD_FIELD, 'Backup location is not a directory'));

        callback(null);
    });
}

function backupDone(backupId, appBackupIds, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback();
}
