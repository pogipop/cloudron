'use strict';

exports = module.exports = {
    backup: backup,
    restore: restore,
    copyBackup: copyBackup,
    removeBackups: removeBackups,

    backupDone: backupDone,

    testConfig: testConfig
};

var assert = require('assert'),
    async = require('async'),
    BackupsError = require('../backups.js').BackupsError,
    config = require('../config.js'),
    debug = require('debug')('box:storage/filesystem'),
    fs = require('fs'),
    once = require('once'),
    path = require('path'),
    safe = require('safetydance'),
    shell = require('../shell.js');

var FALLBACK_BACKUP_FOLDER = '/var/backups';
var RCLONE_CMD = '/usr/bin/rclone';
var RCLONE_ARGS = '--stats 10s --stats-log-level INFO'.split(' ');
var BACKUP_USER = config.TEST ? process.env.USER : 'yellowtent';
var CHOWNBACKUP_CMD = path.join(__dirname, '../scripts/chownbackup.sh');

// internal only
function getBackupFilePath(apiConfig, backupId) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');

    return path.join(apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER, backupId);
}

// storage api
function backup(apiConfig, backupId, sourceDir, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof sourceDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var backupFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] backup: %s -> %s', backupId, sourceDir, backupFilePath);

    var password = apiConfig.key ? safe.child_process.execSync('rclone obscure ' + apiConfig.key) : ''; // FIXME: quote the key
    if (password === null) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, safe.error.message));

    // TODO: Add --skip-links (rclone#1480)
    var env = {
        RCLONE_CONFIG_SRC_TYPE: 'local',
        RCLONE_CONFIG_DEST_TYPE: 'local',
        // only used when key is set
        RCLONE_CONFIG_ENC_TYPE: 'crypt',
        RCLONE_CONFIG_ENC_REMOTE: 'dest:' + backupFilePath,
        RCLONE_CONFIG_ENC_FILENAME_ENCRYPTION: 'standard',
        RCLONE_CONFIG_ENC_PASSWORD: password.toString('utf8').trim()
    };
    var args = [ ].concat(RCLONE_CMD, RCLONE_ARGS, 'sync', 'src:' + sourceDir);
    args = args.concat(apiConfig.key ? 'enc:' : ('dest:' + backupFilePath));

    shell.sudo('backup', args, { env: env }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        shell.sudo('chownBackup', [ CHOWNBACKUP_CMD, BACKUP_USER, path.dirname(backupFilePath) ], function (error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

            callback(null);
        });
    });
}

function restore(apiConfig, backupId, destination, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var sourceFilePath = getBackupFilePath(apiConfig, backupId);

    debug('[%s] restore: %s -> %s', backupId, sourceFilePath, destination);

    if (!fs.existsSync(sourceFilePath)) return callback(new BackupsError(BackupsError.NOT_FOUND, 'backup dir does not exist'));

    var password = apiConfig.key ? safe.child_process.execSync('rclone obscure ' + apiConfig.key) : ''; // FIXME: quote the key
    if (password === null) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, safe.error.message));

    var env = {
        RCLONE_CONFIG_SRC_TYPE: 'local',
        RCLONE_CONFIG_DEST_TYPE: 'local',
        // only used when key is set
        RCLONE_CONFIG_ENC_TYPE: 'crypt',
        RCLONE_CONFIG_ENC_REMOTE: 'src:' + sourceFilePath,
        RCLONE_CONFIG_ENC_FILENAME_ENCRYPTION: 'standard',
        RCLONE_CONFIG_ENC_PASSWORD: password.toString('utf8').trim()
    };
    var args = RCLONE_ARGS.concat('copy', apiConfig.key ? 'enc:' : ('src:' + sourceFilePath), 'dest:' + destination);

    shell.exec('restore', RCLONE_CMD, args, { env: env }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

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

    debug('copyBackup: %s -> %s', oldFilePath, newFilePath);

    var args = RCLONE_ARGS.concat('copy', oldFilePath, newFilePath);
    shell.exec('copyBackup', RCLONE_CMD, args, { }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        callback(null);
    });
}

function removeBackups(apiConfig, backupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert(Array.isArray(backupIds));
    assert.strictEqual(typeof callback, 'function');

    async.eachSeries(backupIds, function (id, iteratorCallback) {
        var filePath = getBackupFilePath(apiConfig, id);

        var args = RCLONE_ARGS.concat([ 'purge', filePath ]);
        shell.exec('backup', RCLONE_CMD, args, { }, function (error) {
            if (error) debug('removeBackups: Unable to remove %s : %s', filePath, error.message);

            iteratorCallback();
        });
    }, callback);
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if ('backupFolder' in apiConfig && typeof apiConfig.backupFolder !== 'string') return callback(new BackupsError(BackupsError.BAD_FIELD, 'backupFolder must be string'));

    var backupFolder = apiConfig.backupFolder || FALLBACK_BACKUP_FOLDER;

    fs.stat(backupFolder, function (error, result) {
        if (error) {
            debug('testConfig: %s', backupFolder, error);
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
