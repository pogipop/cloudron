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
    spawn = require('child_process').spawn,
    tar = require('tar-fs'),
    zlib = require('zlib');

function create(sourceDirectories, key, outStream, callback) {
    assert(Array.isArray(sourceDirectories));
    assert.strictEqual(typeof key, 'string');
    assert.strictEqual(typeof callback, 'function');

    var pack = tar.pack('/', {
        entries: sourceDirectories.map(function (m) { return m.source; }),
        map: function(header) {
            sourceDirectories.forEach(function (m) {
                header.name = header.name.replace(new RegExp('^' + m.source + '(/?)'), m.destination + '$1');
            });
            return header;
        }
    });

    var gzip = zlib.createGzip({});
    var encrypt = crypto.createCipher('aes-256-cbc', key);
    var progressStream = progress({ time: 10000 }); // display a progress every 10 seconds

    pack.on('error', function (error) {
        console.error('backup: tar stream error.', error);
        callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    gzip.on('error', function (error) {
        console.error('backup: gzip stream error.', error);
        callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    encrypt.on('error', function (error) {
        console.error('backup: encrypt stream error.', error);
        callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    progressStream.on('progress', function(progress) {
        debug('backup: %s@%s', Math.round(progress.transferred/1024/1024) + 'M', Math.round(progress.speed/1024/1024) + 'Mbps');
    });

    pack.pipe(gzip).pipe(encrypt).pipe(progressStream).pipe(outStream);
}

function extract(inStream, isOldFormat, destination, key, callback) {
    assert.strictEqual(typeof isOldFormat, 'boolean');
    assert.strictEqual(typeof destination, 'string');
    assert.strictEqual(typeof key, 'string');
    assert.strictEqual(typeof callback, 'function');

    mkdirp(destination, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        var decrypt;

        if (isOldFormat) {
            let args = ['aes-256-cbc', '-d', '-pass', 'pass:' + key];
            decrypt = spawn('openssl', args, { stdio: [ 'pipe', 'pipe', process.stderr ]});
        } else {
            decrypt = crypto.createDecipher('aes-256-cbc', key);
        }

        var gunzip = zlib.createGunzip({});
        var progressStream = progress({ time: 10000 }); // display a progress every 10 seconds
        var extract = tar.extract(destination);

        progressStream.on('progress', function(progress) {
            debug('restore: %s@%s', Math.round(progress.transferred/1024/1024) + 'M', Math.round(progress.speed/1024/1024) + 'Mbps');
        });

        decrypt.on('error', function (error) {
            console.error('restore: decrypt stream error.', error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        gunzip.on('error', function (error) {
            console.error('restore: gunzip stream error.', error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        extract.on('error', function (error) {
            console.error('restore: extract stream error.', error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });

        extract.on('finish', function () {
            debug('restore: done.');
            callback(null);
        });

        if (isOldFormat) {
            inStream.pipe(progressStream).pipe(decrypt.stdin);
            decrypt.stdout.pipe(gunzip).pipe(extract);
        } else {
            inStream.pipe(progressStream).pipe(decrypt).pipe(gunzip).pipe(extract);
        }
    });
}
