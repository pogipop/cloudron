'use strict';

exports = module.exports = {
    backup: backup,
    restore: restore,
    copyBackup: copyBackup,
    removeBackups: removeBackups,

    backupDone: backupDone,

    testConfig: testConfig,
};

var assert = require('assert'),
    async = require('async'),
    AWS = require('aws-sdk'),
    BackupsError = require('../backups.js').BackupsError,
    config = require('../config.js'),
    debug = require('debug')('box:storage/caas'),
    once = require('once'),
    path = require('path'),
    safe = require('safetydance'),
    shell = require('../shell.js'),
    superagent = require('superagent');

var RCLONE_CMD = '/usr/bin/rclone';
var RCLONE_ARGS = '--stats 10s --stats-log-level INFO'.split(' ');

// internal only
function getBackupCredentials(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');
    assert(apiConfig.token);

    var url = config.apiServerOrigin() + '/api/v1/boxes/' + config.fqdn() + '/awscredentials';
    superagent.post(url).query({ token: apiConfig.token }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(error);
        if (result.statusCode !== 201) return callback(new Error(result.text));
        if (!result.body || !result.body.credentials) return callback(new Error('Unexpected response: ' + JSON.stringify(result.headers)));

        var credentials = {
            signatureVersion: 'v4',
            accessKeyId: result.body.credentials.AccessKeyId,
            secretAccessKey: result.body.credentials.SecretAccessKey,
            sessionToken: result.body.credentials.SessionToken,
            region: apiConfig.region || 'us-east-1'
        };

        if (apiConfig.endpoint) credentials.endpoint = new AWS.Endpoint(apiConfig.endpoint);

        callback(null, credentials);
    });
}

function getBackupFilePath(apiConfig, backupId) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');

    return path.join(apiConfig.prefix, backupId);
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

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var password = apiConfig.key ? safe.child_process.execSync('rclone obscure ' + apiConfig.key) : ''; // FIXME: quote the key
        if (password === null) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, safe.error.message));

        // TODO: Add --skip-links (rclone#1480)
        var env = {
            RCLONE_CONFIG_SRC_TYPE: 'local',
            RCLONE_CONFIG_DEST_TYPE: 's3',
            RCLONE_CONFIG_ENV_AUTH: '',
            RCLONE_CONFIG_DEST_ACCESS_KEY_ID: credentials.accessKeyId,
            RCLONE_CONFIG_DEST_SECRET_ACCESS_KEY: credentials.secretAccessKey,
            RCLONE_CONFIG_DEST_SESSION_TOKEN: credentials.sessionToken,
            RCLONE_CONFIG_DEST_REGION: credentials.signatureVersion === 'v2' ? 'other-v2-signature': credentials.region,
            RCLONE_CONFIG_DEST_ENDPOINT: credentials.endpoint || '',
            RCLONE_CONFIG_DEST_LOCATION_CONSTRAINT: credentials.region,

            // only used when key is set
            RCLONE_CONFIG_ENC_TYPE: 'crypt',
            RCLONE_CONFIG_ENC_REMOTE: 'dest:' + apiConfig.bucket + '/' + backupFilePath,
            RCLONE_CONFIG_ENC_FILENAME_ENCRYPTION: 'standard',
            RCLONE_CONFIG_ENC_PASSWORD: password.toString('utf8').trim()
        };

        var args = [ ].concat(RCLONE_CMD, RCLONE_ARGS, 'sync', 'src:' + sourceDir);
        args = args.concat(apiConfig.key ? 'enc:' : ('dest:' + apiConfig.bucket + '/' + backupFilePath));

        shell.sudo('backup', args, { env: env }, function (error) {
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

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var password = apiConfig.key ? safe.child_process.execSync('rclone obscure ' + apiConfig.key) : ''; // FIXME: quote the key
        if (password === null) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, safe.error.message));

        var env = {
            RCLONE_CONFIG_SRC_TYPE: 's3',
            RCLONE_CONFIG_DEST_TYPE: 'local',
            RCLONE_CONFIG_ENV_AUTH: '',
            RCLONE_CONFIG_SRC_ACCESS_KEY_ID: credentials.accessKeyId,
            RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY: credentials.secretAccessKey,
            RCLONE_CONFIG_SRC_SESSION_TOKEN: credentials.sessionToken,
            RCLONE_CONFIG_SRC_REGION: credentials.signatureVersion === 'v2' ? 'other-v2-signature': credentials.region,
            RCLONE_CONFIG_SRC_ENDPOINT: credentials.endpoint || '',
            RCLONE_CONFIG_SRC_LOCATION_CONSTRAINT: credentials.region,

            // only used when key is set
            RCLONE_CONFIG_ENC_TYPE: 'crypt',
            RCLONE_CONFIG_ENC_REMOTE: 'src:' + apiConfig.bucket + '/' + sourceFilePath,
            RCLONE_CONFIG_ENC_FILENAME_ENCRYPTION: 'standard',
            RCLONE_CONFIG_ENC_PASSWORD: password.toString('utf8').trim()
        };
        var args = RCLONE_ARGS.concat('copy', apiConfig.key ? 'enc:' : ('src:' + apiConfig.bucket + '/' + sourceFilePath), 'dest:' + destination);

        shell.exec('restore', RCLONE_CMD, args, { env: env }, function (error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

            callback(null);
        });
    });
}

function copyBackup(apiConfig, oldBackupId, newBackupId, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof oldBackupId, 'string');
    assert.strictEqual(typeof newBackupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('copyBackup: %s -> %s', oldBackupId, newBackupId);

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        // TODO: sessionToken is not passed
        var env = {
            RCLONE_CONFIG_S3_TYPE: 's3',
            RCLONE_CONFIG_ENV_AUTH: '',
            RCLONE_CONFIG_S3_ACCESS_KEY_ID: credentials.accessKeyId,
            RCLONE_CONFIG_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
            RCLONE_CONFIG_S3_SESSION_TOKEN: credentials.sessionToken,
            RCLONE_CONFIG_S3_REGION: credentials.signatureVersion === 'v2' ? 'other-v2-signature': credentials.region,
            RCLONE_CONFIG_S3_ENDPOINT: credentials.endpoint || '',
            RCLONE_CONFIG_S3_LOCATION_CONSTRAINT: credentials.region
        };

        var source = path.join(apiConfig.bucket, getBackupFilePath(apiConfig, oldBackupId));
        var destination = path.join(apiConfig.bucket, getBackupFilePath(apiConfig, newBackupId));
        var args = RCLONE_ARGS.concat('copy', 's3:' + source, 's3:' + destination);

        shell.exec('restore', RCLONE_CMD, args, { env: env }, function (error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

            callback(null);
        });
    });
}

function removeBackups(apiConfig, backupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert(Array.isArray(backupIds));
    assert.strictEqual(typeof callback, 'function');

    getBackupCredentials(apiConfig, function (error, credentials) {
        if (error) return callback(error);

        var env = {
            RCLONE_CONFIG_S3_TYPE: 's3',
            RCLONE_CONFIG_ENV_AUTH: '',
            RCLONE_CONFIG_S3_ACCESS_KEY_ID: credentials.accessKeyId,
            RCLONE_CONFIG_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
            RCLONE_CONFIG_S3_SESSION_TOKEN: credentials.sessionToken,
            RCLONE_CONFIG_S3_REGION: credentials.signatureVersion === 'v2' ? 'other-v2-signature': credentials.region,
            RCLONE_CONFIG_S3_ENDPOINT: credentials.endpoint || '',
            RCLONE_CONFIG_S3_LOCATION_CONSTRAINT: credentials.region
        };

        async.eachSeries(backupIds, function (id, iteratorCallback) {
            var filePath = getBackupFilePath(apiConfig, id);

            var args = RCLONE_ARGS.concat('purge', 's3:' + filePath);
            shell.exec('backup', RCLONE_CMD, args, { env: env }, function (error) {
                if (error) debug('removeBackups: Unable to remove %s : %s', filePath, error.message);

                iteratorCallback();
            });
        }, callback);
    });
}

function testConfig(apiConfig, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (config.provider() !== 'caas') return callback(new BackupsError(BackupsError.BAD_FIELD, 'instance provider must be caas'));

    callback();
}

function backupDone(backupId, appBackupIds, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    debug('[%s] backupDone: %s apps %j', backupId, backupId, appBackupIds);

    var url = config.apiServerOrigin() + '/api/v1/boxes/' + config.fqdn() + '/backupDone';
    var data = {
        boxVersion: config.version(),
        restoreKey: backupId,
        appId: null,        // now unused
        appVersion: null,   // now unused
        appBackupIds: appBackupIds
    };

    superagent.post(url).send(data).query({ token: config.token() }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));
        if (result.statusCode !== 200) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, result.text));

        return callback(null);
    });
}
