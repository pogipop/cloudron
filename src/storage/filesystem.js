'use strict';

exports = module.exports = {
    upload: upload,
    download: download,
    downloadDir: downloadDir,

    copy: copy,

    remove: remove,
    removeDir: removeDir,

    backupDone: backupDone,

    testConfig: testConfig
};

var assert = require('assert'),
    BackupsError = require('../backups.js').BackupsError,
    debug = require('debug')('box:storage/filesystem'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    PassThrough = require('stream').PassThrough,
    path = require('path'),
    safe = require('safetydance'),
    shell = require('../shell.js');

// storage api
function upload(apiConfig, backupFilePath, sourceStream, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof sourceStream, 'object');
    assert.strictEqual(typeof callback, 'function');

    mkdirp(path.dirname(backupFilePath), function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        safe.fs.unlinkSync(backupFilePath); // remove any hardlink

        var fileStream = fs.createWriteStream(backupFilePath);

        // this pattern is required to ensure that the file got created before 'finish'
        fileStream.on('open', function () {
            sourceStream.pipe(fileStream);
        });

        fileStream.on('error', function (error) {
            debug('[%s] upload: out stream error.', backupFilePath, error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        fileStream.on('finish', function () {
            // in test, upload() may or may not be called via sudo script
            const BACKUP_UID = parseInt(process.env.SUDO_UID, 10) || process.getuid();

            if (!safe.fs.chownSync(backupFilePath, BACKUP_UID, BACKUP_UID)) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, 'Unable to chown:' + safe.error.message));
            if (!safe.fs.chownSync(path.dirname(backupFilePath), BACKUP_UID, BACKUP_UID)) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, 'Unable to chown:' + safe.error.message));

            debug('upload %s: done.', backupFilePath);

            callback(null);
        });
    });
}

function download(apiConfig, sourceFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof sourceFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('download: %s', sourceFilePath);

    var ps = new PassThrough();
    var fileStream = fs.createReadStream(sourceFilePath);
    fileStream.on('error', function (error) {
        ps.emit('error', new BackupsError(BackupsError.NOT_FOUND, error.message));
    });
    fileStream.pipe(ps);
    callback(null, ps);
}

function downloadDir(apiConfig, backupFilePath, destDir, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert.strictEqual(typeof destDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('downloadDir: %s -> %s', backupFilePath, destDir);

    shell.exec('downloadDir', '/bin/cp', [ '-r', backupFilePath + '/.', destDir ], { }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        callback();
    });
}

function copy(apiConfig, oldFilePath, newFilePath, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

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

function remove(apiConfig, filename, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof filename, 'string');
    assert.strictEqual(typeof callback, 'function');

    safe.fs.unlinkSync(filename);

    safe.fs.rmdirSync(path.dirname(filename)); // try to cleanup empty directories

    callback();
}

function removeDir(apiConfig, pathPrefix, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');
    assert.strictEqual(typeof callback, 'function');

    shell.exec('removeDir', '/bin/rm', [ '-rf', pathPrefix ], { }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        safe.fs.rmdirSync(path.dirname(pathPrefix)); // try to cleanup empty directories

        callback();
    });
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

function backupDone(apiConfig, backupId, appBackupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback();
}
