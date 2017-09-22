'use strict';

exports = module.exports = {
    upload: upload,
    download: download,
    downloadDir: downloadDir,

    copy: copy,

    remove: remove,

    backupDone: backupDone,

    testConfig: testConfig
};

var assert = require('assert'),
    BackupsError = require('../backups.js').BackupsError,
    config = require('../config.js'),
    debug = require('debug')('box:storage/filesystem'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    PassThrough = require('stream').PassThrough,
    path = require('path'),
    safe = require('safetydance'),
    shell = require('../shell.js');

var BACKUP_USER = config.TEST ? process.env.USER : 'yellowtent';

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

        fileStream.on('error', function (error) {
            debug('[%s] upload: out stream error.', backupFilePath, error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        fileStream.on('close', function () {
            if (!safe.child_process.execSync('chown -R ' + BACKUP_USER + ':' + BACKUP_USER + ' ' + path.dirname(backupFilePath))) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, safe.error.message));

            debug('upload %s: done.', backupFilePath);

            callback(null);
        });

        sourceStream.pipe(fileStream);
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

    shell.exec('copy', '/bin/cp', [ '-r', backupFilePath + '/.', destDir ], { }, function (error) {
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

function remove(apiConfig, pathPrefix, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');
    assert.strictEqual(typeof callback, 'function');

    shell.exec('remove', '/bin/rm', [ '-rf', pathPrefix ], { }, function (error) {
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

function backupDone(backupId, appBackupIds, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    callback();
}
