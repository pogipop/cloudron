'use strict';

exports = module.exports = {
    upload: upload,
    download: download,

    copy: copy,

    listDir: listDir,

    remove: remove,
    removeDir: removeDir,

    testConfig: testConfig,
    removePrivateFields: removePrivateFields,
    injectPrivateFields: injectPrivateFields
};

var assert = require('assert'),
    BackupsError = require('../backups.js').BackupsError,
    debug = require('debug')('box:storage/filesystem'),
    EventEmitter = require('events'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    path = require('path'),
    readdirp = require('readdirp'),
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

    debug(`download: ${sourceFilePath}`);

    if (!safe.fs.existsSync(sourceFilePath)) return callback(new BackupsError(BackupsError.NOT_FOUND, `File not found: ${sourceFilePath}`));

    var fileStream = fs.createReadStream(sourceFilePath);
    callback(null, fileStream);
}

function listDir(apiConfig, dir, batchSize, iteratorCallback, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof dir, 'string');
    assert.strictEqual(typeof batchSize, 'number');
    assert.strictEqual(typeof iteratorCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    var entries = [];
    var entryStream = readdirp({ root: dir, entryType: 'files', lstat: true });
    entryStream.on('data', function (data) {
        if (data.stat.isSymbolicLink()) return;

        entries.push({ fullPath: data.fullPath });
        if (entries.length < batchSize) return;
        entryStream.pause();
        iteratorCallback(entries, function (error) {
            if (error) return callback(error);

            entries = [];
            entryStream.resume();
        });
    });
    entryStream.on('warn', function (error) {
        debug('listDir: warning ', error);
    });
    entryStream.on('end', function () {
        iteratorCallback(entries, callback);
    });
}

function copy(apiConfig, oldFilePath, newFilePath) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldFilePath, 'string');
    assert.strictEqual(typeof newFilePath, 'string');

    debug('copy: %s -> %s', oldFilePath, newFilePath);

    var events = new EventEmitter();

    mkdirp(path.dirname(newFilePath), function (error) {
        if (error) return events.emit('done', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        // this will hardlink backups saving space
        var cpOptions = apiConfig.noHardlinks ? '-a' : '-al';
        shell.spawn('copy', '/bin/cp', [ cpOptions, oldFilePath, newFilePath ], { }, function (error) {
            if (error) return events.emit('done', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

            events.emit('done', null);
        });
    });

    return events;
}

function remove(apiConfig, filename, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof filename, 'string');
    assert.strictEqual(typeof callback, 'function');

    var stat = safe.fs.statSync(filename);
    if (!stat) return callback();

    if (stat.isFile()) {
        if (!safe.fs.unlinkSync(filename)) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, safe.error.message));
    } else if (stat.isDirectory()) {
        if (!safe.fs.rmdirSync(filename)) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, safe.error.message));
    }

    callback(null);
}

function removeDir(apiConfig, pathPrefix) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof pathPrefix, 'string');

    var events = new EventEmitter();

    events.emit('progress', `removeDir: ${pathPrefix}`);

    shell.spawn('removeDir', '/bin/rm', [ '-rf', pathPrefix ], { }, function (error) {
        if (error) return events.emit('done', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        events.emit('done', null);
    });

    return events;
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (typeof apiConfig.backupFolder !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'backupFolder must be string'));

    if (!apiConfig.backupFolder) return callback(new BackupsError(BackupsError.BAD_FIELD, 'backupFolder is required'));

    if ('noHardlinks' in apiConfig && typeof apiConfig.noHardlinks !== 'boolean') return callback(new BackupsError(BackupsError.BAD_FIELD, 'noHardlinks must be boolean'));

    if ('externalDisk' in apiConfig && typeof apiConfig.externalDisk !== 'boolean') return callback(new BackupsError(BackupsError.BAD_FIELD, 'externalDisk must be boolean'));

    fs.stat(apiConfig.backupFolder, function (error, result) {
        if (error) return callback(new BackupsError(BackupsError.BAD_FIELD, 'Directory does not exist or cannot be accessed: ' + error.message));
        if (!result.isDirectory()) return callback(new BackupsError(BackupsError.BAD_FIELD, 'Backup location is not a directory'));

        mkdirp(path.join(apiConfig.backupFolder, 'snapshot'), function (error) {
            if (error && error.code === 'EACCES') return callback(new BackupsError(BackupsError.BAD_FIELD, `Access denied. Run "chown yellowtent:yellowtent ${apiConfig.backupFolder}" on the server`));
            if (error) return callback(new BackupsError(BackupsError.BAD_FIELD, error.message));

            callback(null);
        });
    });
}

function removePrivateFields(apiConfig) {
    return apiConfig;
}

function injectPrivateFields(/* newConfig, currentConfig */) {
}
