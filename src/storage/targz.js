'use strict';

exports = module.exports = {
    create: create,
    extract: extract
};

var assert = require('assert'),
    BackupsError = require('../backups.js').BackupsError,
    crypto = require('crypto'),
    debug = require('debug')('box:storage/targz'),
    mkdirp = require('mkdirp'),
    path = require('path'),
    progress = require('progress-stream'),
    shell = require('../shell.js'),
    tar = require('tar-fs'),
    zlib = require('zlib');

var TARJS_CMD = path.join(__dirname, '../scripts/tar.js');

// curiously, this function never calls back on success :-)
function create(sourceDir, key, outStream, callback) {
    assert.strictEqual(typeof sourceDir, 'string');
    assert(key === null || typeof key === 'string');
    assert.strictEqual(typeof callback, 'function');

    var pack = shell.sudo('tar', [ TARJS_CMD, sourceDir ], { noDebugStdout: true, timeout: 4 * 60 * 60 * 1000 }, function (error) {
        if (error) callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    var gzip = zlib.createGzip({});
    var progressStream = progress({ time: 10000 }); // display a progress every 10 seconds

    gzip.on('error', function (error) {
        debug('backup: gzip stream error.', error);
        callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    progressStream.on('progress', function(progress) {
        debug('backup: %s@%s', Math.round(progress.transferred/1024/1024) + 'M', Math.round(progress.speed/1024/1024) + 'Mbps');
    });

    if (key !== null) {
        var encrypt = crypto.createCipher('aes-256-cbc', key);
        encrypt.on('error', function (error) {
            debug('backup: encrypt stream error.', error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });
        pack.stdout.pipe(gzip).pipe(encrypt).pipe(progressStream).pipe(outStream);
    } else {
        pack.stdout.pipe(gzip).pipe(progressStream).pipe(outStream);
    }
}

function extract(inStream, destination, key, callback) {
    assert.strictEqual(typeof destination, 'string');
    assert(key === null || typeof key === 'string');
    assert.strictEqual(typeof callback, 'function');

    mkdirp(destination, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        var gunzip = zlib.createGunzip({});
        var progressStream = progress({ time: 10000 }); // display a progress every 10 seconds
        var extract = tar.extract(destination);

        progressStream.on('progress', function(progress) {
            debug('restore: %s@%s', Math.round(progress.transferred/1024/1024) + 'M', Math.round(progress.speed/1024/1024) + 'Mbps');
        });

        gunzip.on('error', function (error) {
            debug('restore: gunzip stream error.', error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        extract.on('error', function (error) {
            debug('restore: extract stream error.', error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        extract.on('finish', function () {
            debug('restore: done.');
            callback(null);
        });

        if (key !== null) {
            var decrypt = crypto.createDecipher('aes-256-cbc', key);
            decrypt.on('error', function (error) {
                debug('restore: decrypt stream error.', error);
                callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
            });
            inStream.pipe(progressStream).pipe(decrypt).pipe(gunzip).pipe(extract);
        } else {
            inStream.pipe(progressStream).pipe(gunzip).pipe(extract);
        }
    });
}
