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
    progress = require('progress-stream'),
    tar = require('tar-fs'),
    zlib = require('zlib');

// curiously, this function never calls back on success :-)
function create(sourceDir, key, outStream, callback) {
    assert.strictEqual(typeof sourceDir, 'string');
    assert(key === null || typeof key === 'string');
    assert.strictEqual(typeof callback, 'function');

    var pack = tar.pack('/', {
        dereference: false, // pack the symlink and not what it points to
        entries: [ sourceDir ],
        map: function(header) {
            header.name = header.name.replace(new RegExp('^' + sourceDir + '(/?)'), '.$1'); // make paths relative
            return header;
        },
        strict: false // do not error for unknown types (skip fifo, char/block devices)
    });

    var gzip = zlib.createGzip({});
    var progressStream = progress({ time: 10000 }); // display a progress every 10 seconds

    pack.on('error', function (error) {
        debug('backup: tar stream error.', error);
        callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

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
        pack.pipe(gzip).pipe(encrypt).pipe(progressStream).pipe(outStream);
    } else {
        pack.pipe(gzip).pipe(progressStream).pipe(outStream);
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
