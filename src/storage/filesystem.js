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
    shell = require('../shell.js'),
    targz = require('./targz.js');

var BACKUP_USER = config.TEST ? process.env.USER : 'yellowtent';

// storage api
function upload(apiConfig, backupFilePath, sourceDir, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof sourceDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    debug('backup: %s -> %s', sourceDir, backupFilePath);

    mkdirp(path.dirname(backupFilePath), function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        var fileStream = fs.createWriteStream(backupFilePath);

        fileStream.on('error', function (error) {
            debug('[%s] backup: out stream error.', backupFilePath, error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        fileStream.on('close', function () {
            debug('[%s] backup: changing ownership.', backupFilePath);

            if (!safe.child_process.execSync('chown -R ' + BACKUP_USER + ':' + BACKUP_USER + ' ' + path.dirname(backupFilePath))) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, safe.error.message));

            debug('[%s] backup: done.', backupFilePath);

            callback(null);
        });

        targz.create(sourceDir, apiConfig.key || null, fileStream, callback);
    });
}

function download(apiConfig, sourceFilePath, destination, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof sourceFilePath, 'string');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    debug('restore: %s -> %s', sourceFilePath, destination);

    if (!fs.existsSync(sourceFilePath)) return callback(new BackupsError(BackupsError.NOT_FOUND, 'backup file does not exist'));

    var fileStream = fs.createReadStream(sourceFilePath);

    fileStream.on('error', function (error) {
        debug('restore: file stream error.', error);
        callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    targz.extract(fileStream, destination, apiConfig.key || null, callback);
}

function copy(apiConfig, oldFilePath, newFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    debug('copy: %s -> %s', oldFilePath, newFilePath);

    mkdirp(path.dirname(newFilePath), function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        // this will hardlink backups saving space
        shell.exec('copy', '/bin/cp', [ '-al', oldFilePath, newFilePath ], { }, function (error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

            callback();
        });
    });
}

function removeMany(apiConfig, filePaths, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert(Array.isArray(filePaths));
    assert.strictEqual(typeof callback, 'function');

    async.eachSeries(filePaths, function (filePath, iteratorCallback) {
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

    if (typeof apiConfig.backupFolder !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'backupFolder must be string'));

    if (!apiConfig.backupFolder) return callback(new BackupsError(BackupsError.BAD_FIELD, 'backupFolder is required'));

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
