'use strict';

exports = module.exports = {
    BackupsError: BackupsError,

    testConfig: testConfig,

    getByStatePaged: getByStatePaged,
    getByAppIdPaged: getByAppIdPaged,

    get: get,

    startBackupTask: startBackupTask,
    ensureBackup: ensureBackup,

    restore: restore,

    backupApp: backupApp,
    restoreApp: restoreApp,

    backupBoxAndApps: backupBoxAndApps,

    upload: upload,

    startCleanupTask: startCleanupTask,
    cleanup: cleanup,
    cleanupCacheFilesSync: cleanupCacheFilesSync,

    // for testing
    _getBackupFilePath: getBackupFilePath,
    _restoreFsMetadata: restoreFsMetadata,
    _saveFsMetadata: saveFsMetadata
};

var addons = require('./addons.js'),
    appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    AppsError = require('./apps.js').AppsError,
    async = require('async'),
    assert = require('assert'),
    backupdb = require('./backupdb.js'),
    config = require('./config.js'),
    crypto = require('crypto'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror.js'),
    DataLayout = require('./datalayout.js'),
    debug = require('debug')('box:backups'),
    eventlog = require('./eventlog.js'),
    fs = require('fs'),
    locker = require('./locker.js'),
    mailer = require('./mailer.js'),
    mkdirp = require('mkdirp'),
    once = require('once'),
    path = require('path'),
    paths = require('./paths.js'),
    progressStream = require('progress-stream'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    settings = require('./settings.js'),
    superagent = require('superagent'),
    syncer = require('./syncer.js'),
    tar = require('tar-fs'),
    tasks = require('./tasks.js'),
    util = require('util'),
    zlib = require('zlib');

const BACKUP_UPLOAD_CMD = path.join(__dirname, 'scripts/backupupload.js');

function debugApp(app) {
    assert(typeof app === 'object');

    debug(app.fqdn + ' ' + util.format.apply(util, Array.prototype.slice.call(arguments, 1)));
}

function BackupsError(reason, errorOrMessage) {
    assert.strictEqual(typeof reason, 'string');
    assert(errorOrMessage instanceof Error || typeof errorOrMessage === 'string' || typeof errorOrMessage === 'undefined');

    Error.call(this);
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name;
    this.reason = reason;
    if (typeof errorOrMessage === 'undefined') {
        this.message = reason;
    } else if (typeof errorOrMessage === 'string') {
        this.message = errorOrMessage;
    } else {
        this.message = 'Internal error';
        this.nestedError = errorOrMessage;
    }
}
util.inherits(BackupsError, Error);
BackupsError.EXTERNAL_ERROR = 'external error';
BackupsError.INTERNAL_ERROR = 'internal error';
BackupsError.BAD_STATE = 'bad state';
BackupsError.BAD_FIELD = 'bad field';
BackupsError.NOT_FOUND = 'not found';

// choose which storage backend we use for test purpose we use s3
function api(provider) {
    switch (provider) {
    case 'caas': return require('./storage/s3.js');
    case 's3': return require('./storage/s3.js');
    case 'gcs': return require('./storage/gcs.js');
    case 'filesystem': return require('./storage/filesystem.js');
    case 'minio': return require('./storage/s3.js');
    case 's3-v4-compat': return require('./storage/s3.js');
    case 'digitalocean-spaces': return require('./storage/s3.js');
    case 'exoscale-sos': return require('./storage/s3.js');
    case 'noop': return require('./storage/noop.js');
    default: return null;
    }
}

function testConfig(backupConfig, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    var func = api(backupConfig.provider);
    if (!func) return callback(new BackupsError(BackupsError.BAD_FIELD, 'unknown storage provider'));

    if (backupConfig.format !== 'tgz' && backupConfig.format !== 'rsync') return callback(new BackupsError(BackupsError.BAD_FIELD, 'unknown format'));

    // remember to adjust the cron ensureBackup task interval accordingly
    if (backupConfig.intervalSecs < 6 * 60 * 60) return callback(new BackupsError(BackupsError.BAD_FIELD, 'Interval must be atleast 6 hours'));

    api(backupConfig.provider).testConfig(backupConfig, callback);
}

function getByStatePaged(state, page, perPage, callback) {
    assert.strictEqual(typeof state, 'string');
    assert(typeof page === 'number' && page > 0);
    assert(typeof perPage === 'number' && perPage > 0);
    assert.strictEqual(typeof callback, 'function');

    backupdb.getByTypeAndStatePaged(backupdb.BACKUP_TYPE_BOX, state, page, perPage, function (error, results) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        callback(null, results);
    });
}

function getByAppIdPaged(page, perPage, appId, callback) {
    assert(typeof page === 'number' && page > 0);
    assert(typeof perPage === 'number' && perPage > 0);
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    backupdb.getByAppIdPaged(page, perPage, appId, function (error, results) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        callback(null, results);
    });
}

function get(backupId, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    backupdb.get(backupId, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new BackupsError(BackupsError.NOT_FOUND));
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        callback(null, result);
    });
}

function getBackupFilePath(backupConfig, backupId, format) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof format, 'string');

    if (format === 'tgz') {
        const fileType = backupConfig.key ? '.tar.gz.enc' : '.tar.gz';
        return path.join(backupConfig.prefix || backupConfig.backupFolder || '', backupId+fileType);
    } else {
        return path.join(backupConfig.prefix || backupConfig.backupFolder || '', backupId);
    }
}

function encryptFilePath(filePath, key) {
    assert.strictEqual(typeof filePath, 'string');
    assert.strictEqual(typeof key, 'string');

    var encryptedParts = filePath.split('/').map(function (part) {
        const cipher = crypto.createCipher('aes-256-cbc', key);
        let crypt = cipher.update(part);
        crypt = Buffer.concat([ crypt, cipher.final() ]);

        return crypt.toString('base64')     // ensures path is valid
            .replace(/\//g, '-')            // replace '/' of base64 since it conflicts with path separator
            .replace(/=/g,'');              // strip trailing = padding. this is only needed if we concat base64 strings, which we don't
    });

    return encryptedParts.join('/');
}

function decryptFilePath(filePath, key) {
    assert.strictEqual(typeof filePath, 'string');
    assert.strictEqual(typeof key, 'string');

    let decryptedParts = [];
    for (let part of filePath.split('/')) {
        part = part + Array(part.length % 4).join('='); // add back = padding
        part = part.replace(/-/g, '/');                 // replace with '/'

        try {
            let decrypt = crypto.createDecipher('aes-256-cbc', key);
            let text = decrypt.update(Buffer.from(part, 'base64'));
            text = Buffer.concat([ text, decrypt.final() ]);
            decryptedParts.push(text.toString('utf8'));
        } catch (error) {
            debug(`Error decrypting file ${filePath} part ${part}:`, error);
            return null;
        }
    }

    return decryptedParts.join('/');
}

function createReadStream(sourceFile, key) {
    assert.strictEqual(typeof sourceFile, 'string');
    assert(key === null || typeof key === 'string');

    var stream = fs.createReadStream(sourceFile);
    var ps = progressStream({ time: 10000 }); // display a progress every 10 seconds

    stream.on('error', function (error) {
        debug('createReadStream: read stream error.', error);
        ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    if (key !== null) {
        var encrypt = crypto.createCipher('aes-256-cbc', key);
        encrypt.on('error', function (error) {
            debug('createReadStream: encrypt stream error.', error);
            ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });
        return stream.pipe(encrypt).pipe(ps);
    } else {
        return stream.pipe(ps);
    }
}

function createWriteStream(destFile, key) {
    assert.strictEqual(typeof destFile, 'string');
    assert(key === null || typeof key === 'string');

    var stream = fs.createWriteStream(destFile);

    if (key !== null) {
        var decrypt = crypto.createDecipher('aes-256-cbc', key);
        decrypt.on('error', function (error) {
            debug('createWriteStream: decrypt stream error.', error);
        });
        decrypt.pipe(stream);
        return decrypt;
    } else {
        return stream;
    }
}

function tarPack(dataLayout, key, callback) {
    assert(dataLayout instanceof DataLayout, 'dataLayout must be a DataLayout');
    assert(key === null || typeof key === 'string');
    assert.strictEqual(typeof callback, 'function');

    var pack = tar.pack('/', {
        dereference: false, // pack the symlink and not what it points to
        entries: dataLayout.localPaths(),
        map: function(header) {
            header.name = dataLayout.toRemotePath(header.name);
            return header;
        },
        strict: false // do not error for unknown types (skip fifo, char/block devices)
    });

    var gzip = zlib.createGzip({});
    var ps = progressStream({ time: 10000 }); // emit 'pgoress' every 10 seconds

    pack.on('error', function (error) {
        debug('tarPack: tar stream error.', error);
        ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    gzip.on('error', function (error) {
        debug('tarPack: gzip stream error.', error);
        ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    if (key !== null) {
        var encrypt = crypto.createCipher('aes-256-cbc', key);
        encrypt.on('error', function (error) {
            debug('tarPack: encrypt stream error.', error);
            ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });
        pack.pipe(gzip).pipe(encrypt).pipe(ps);
    } else {
        pack.pipe(gzip).pipe(ps);
    }

    callback(null, ps);
}

function sync(backupConfig, backupId, dataLayout, progressCallback, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(dataLayout instanceof DataLayout, 'dataLayout must be a DataLayout');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    // the number here has to take into account the s3.upload partSize (which is 10MB). So 20=200MB
    const concurrency = backupConfig.syncConcurrency || (backupConfig.provider === 's3' ? 20 : 10);

    syncer.sync(dataLayout, function processTask(task, iteratorCallback) {
        debug('sync: processing task: %j', task);
        // the empty task.path is special to signify the directory
        const destPath = task.path && backupConfig.key ? encryptFilePath(task.path, backupConfig.key) : task.path;
        const backupFilePath = path.join(getBackupFilePath(backupConfig, backupId, backupConfig.format), destPath);

        if (task.operation === 'removedir') {
            debug(`Removing directory ${backupFilePath}`);
            return api(backupConfig.provider).removeDir(backupConfig, backupFilePath)
                .on('progress', (message) => progressCallback({ message }))
                .on('done', iteratorCallback);
        } else if (task.operation === 'remove') {
            debug(`Removing ${backupFilePath}`);
            return api(backupConfig.provider).remove(backupConfig, backupFilePath, iteratorCallback);
        }

        var retryCount = 0;
        async.retry({ times: 5, interval: 20000 }, function (retryCallback) {
            retryCallback = once(retryCallback); // protect again upload() erroring much later after read stream error

            ++retryCount;
            if (task.operation === 'add') {
                progressCallback({ message: `Adding ${task.path}` + (retryCount > 1 ?  ` (Try ${retryCount})` : '') });
                debug(`Adding ${task.path} position ${task.position} try ${retryCount}`);
                var stream = createReadStream(dataLayout.toLocalPath('./' + task.path), backupConfig.key || null);
                stream.on('error', function (error) {
                    debug(`read stream error for ${task.path}: ${error.message}`);
                    retryCallback();
                }); // ignore error if file disappears
                stream.on('progress', function(progress) {
                    const transferred = Math.round(progress.transferred/1024/1024), speed = Math.round(progress.speed/1024/1024);
                    if (!transferred && !speed) return progressCallback({ message: `Uploading ${task.path}` }); // 0M@0Mbps looks wrong
                    progressCallback({ message: `Uploading ${task.path}: ${transferred}M@${speed}Mbps` }); // 0M@0Mbps looks wrong
                });
                api(backupConfig.provider).upload(backupConfig, backupFilePath, stream, function (error) {
                    debug(error ? `Error uploading ${task.path} try ${retryCount}: ${error.message}` : `Uploaded ${task.path}`);
                    retryCallback(error);
                });
            }
        }, iteratorCallback);
    }, concurrency, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        callback();
    });
}

// this is not part of 'snapshotting' because we need root access to traverse
function saveFsMetadata(dataLayout, metadataFile, callback) {
    assert(dataLayout instanceof DataLayout, 'dataLayout must be a DataLayout');
    assert.strictEqual(typeof metadataFile, 'string');
    assert.strictEqual(typeof callback, 'function');

    // contains paths prefixed with './'
    let metadata = {
        emptyDirs: [],
        execFiles: []
    };

    for (let lp of dataLayout.localPaths()) {
        var emptyDirs = safe.child_process.execSync(`find ${lp} -type d -empty\n`, { encoding: 'utf8' });
        if (emptyDirs === null) return callback(safe.error);
        if (emptyDirs.length) metadata.emptyDirs = metadata.emptyDirs.concat(emptyDirs.trim().split('\n').map((ed) => dataLayout.toRemotePath(ed)));

        var execFiles = safe.child_process.execSync(`find ${lp} -type f -executable\n`, { encoding: 'utf8' });
        if (execFiles === null) return callback(safe.error);

        if (execFiles.length) metadata.execFiles = metadata.execFiles.concat(execFiles.trim().split('\n').map((ef) => dataLayout.toRemotePath(ef)));
    }

    if (!safe.fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 4))) return callback(safe.error);

    callback();
}

// this function is called via backupupload (since it needs root to traverse app's directory)
function upload(backupId, format, dataLayoutString, progressCallback, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof format, 'string');
    assert.strictEqual(typeof dataLayoutString, 'string');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    debug(`upload: id ${backupId} format ${format} dataLayout ${dataLayoutString}`);

    const dataLayout = DataLayout.fromString(dataLayoutString);

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        if (format === 'tgz') {
            async.retry({ times: 5, interval: 20000 }, function (retryCallback) {
                retryCallback = once(retryCallback); // protect again upload() erroring much later after tar stream error

                tarPack(dataLayout, backupConfig.key || null, function (error, tarStream) {
                    if (error) return retryCallback(error);

                    tarStream.on('progress', function(progress) {
                        const transferred = Math.round(progress.transferred/1024/1024), speed = Math.round(progress.speed/1024/1024);
                        if (!transferred && !speed) return progressCallback({ message: 'Uploading backup' }); // 0M@0Mbps looks wrong
                        progressCallback({ message: `Uploading backup ${transferred}M@${speed}Mbps` });
                    });
                    tarStream.on('error', retryCallback); // already returns BackupsError

                    api(backupConfig.provider).upload(backupConfig, getBackupFilePath(backupConfig, backupId, format), tarStream, retryCallback);
                });
            }, callback);
        } else {
            async.series([
                saveFsMetadata.bind(null, dataLayout, `${dataLayout.localRoot()}/fsmetadata.json`),
                sync.bind(null, backupConfig, backupId, dataLayout, progressCallback)
            ], callback);
        }
    });
}

function tarExtract(inStream, dataLayout, key, callback) {
    assert.strictEqual(typeof inStream, 'object');
    assert(dataLayout instanceof DataLayout, 'dataLayout must be a DataLayout');
    assert(key === null || typeof key === 'string');
    assert.strictEqual(typeof callback, 'function');

    var gunzip = zlib.createGunzip({});
    var ps = progressStream({ time: 10000 }); // display a progress every 10 seconds
    var extract = tar.extract('/', {
        map: function (header) {
            header.name = dataLayout.toLocalPath(header.name);
            return header;
        }
    });

    const emitError = once((error) => ps.emit('error', error));

    inStream.on('error', function (error) {
        debug('tarExtract: input stream error.', error);
        emitError(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    gunzip.on('error', function (error) {
        debug('tarExtract: gunzip stream error.', error);
        emitError(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    extract.on('error', function (error) {
        debug('tarExtract: extract stream error.', error);
        emitError(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    extract.on('finish', function () {
        debug('tarExtract: done.');
        // we use a separate event because ps is a through2 stream which emits 'finish' event indicating end of inStream and not extract
        ps.emit('done');
    });

    if (key !== null) {
        var decrypt = crypto.createDecipher('aes-256-cbc', key);
        decrypt.on('error', function (error) {
            debug('tarExtract: decrypt stream error.', error);
            emitError(new BackupsError(BackupsError.EXTERNAL_ERROR, `Failed to decrypt: ${error.message}`));
        });
        inStream.pipe(ps).pipe(decrypt).pipe(gunzip).pipe(extract);
    } else {
        inStream.pipe(ps).pipe(gunzip).pipe(extract);
    }

    callback(null, ps);
}

function restoreFsMetadata(dataLayout, metadataFile, callback) {
    assert(dataLayout instanceof DataLayout, 'dataLayout must be a DataLayout');
    assert.strictEqual(typeof metadataFile, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`Recreating empty directories in ${dataLayout.toString()}`);

    var metadataJson = safe.fs.readFileSync(metadataFile, 'utf8');
    if (metadataJson === null) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, 'Error loading fsmetadata.txt:' + safe.error.message));
    var metadata = safe.JSON.parse(metadataJson);
    if (metadata === null) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, 'Error parsing fsmetadata.txt:' + safe.error.message));

    async.eachSeries(metadata.emptyDirs, function createPath(emptyDir, iteratorDone) {
        mkdirp(dataLayout.toLocalPath(emptyDir), iteratorDone);
    }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, `unable to create path: ${error.message}`));

        async.eachSeries(metadata.execFiles, function createPath(execFile, iteratorDone) {
            fs.chmod(dataLayout.toLocalPath(execFile), parseInt('0755', 8), iteratorDone);
        }, function (error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, `unable to chmod: ${error.message}`));

            callback();
        });
    });
}

function downloadDir(backupConfig, backupFilePath, dataLayout, progressCallback, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupFilePath, 'string');
    assert(dataLayout instanceof DataLayout, 'dataLayout must be a DataLayout');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    debug(`downloadDir: ${backupFilePath} to ${dataLayout.toString()}`);

    function downloadFile(entry, callback) {
        let relativePath = path.relative(backupFilePath, entry.fullPath);
        if (backupConfig.key) {
            relativePath = decryptFilePath(relativePath, backupConfig.key);
            if (!relativePath) return callback(new BackupsError(BackupsError.BAD_STATE, 'Unable to decrypt file'));
        }
        const destFilePath = dataLayout.toLocalPath('./' + relativePath);

        mkdirp(path.dirname(destFilePath), function (error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

            async.retry({ times: 5, interval: 20000 }, function (retryCallback) {
                let destStream = createWriteStream(destFilePath, backupConfig.key || null);

                // protect against multiple errors. must destroy the write stream so that a previous retry does not write
                let closeAndRetry = once((error) => {
                    if (error) progressCallback({ message: `Download ${entry.fullPath} errored: ${error.message}` });
                    else progressCallback({ message: `Download ${entry.fullPath} finished` });
                    destStream.destroy();
                    retryCallback(error);
                });

                api(backupConfig.provider).download(backupConfig, entry.fullPath, function (error, sourceStream) {
                    if (error) return closeAndRetry(error);

                    sourceStream.on('error', closeAndRetry);
                    destStream.on('error', closeAndRetry);

                    progressCallback({ message: `Downloading ${entry.fullPath} to ${destFilePath}` });

                    sourceStream.pipe(destStream, { end: true }).on('finish', closeAndRetry);
                });
            }, callback);
        });
    }

    api(backupConfig.provider).listDir(backupConfig, backupFilePath, 1000, function (entries, done) {
        // https://www.digitalocean.com/community/questions/rate-limiting-on-spaces?answer=40441
        const concurrency = backupConfig.downloadConcurrency || (backupConfig.provider === 's3' ? 30 : 10);

        async.eachLimit(entries, concurrency, downloadFile, done);
    }, callback);
}

function download(backupConfig, backupId, format, dataLayout, progressCallback, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof format, 'string');
    assert(dataLayout instanceof DataLayout, 'dataLayout must be a DataLayout');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    debug(`download - Downloading ${backupId} of format ${format} to ${dataLayout.toString()}`);

    const backupFilePath = getBackupFilePath(backupConfig, backupId, format);

    if (format === 'tgz') {
        async.retry({ times: 5, interval: 20000 }, function (retryCallback) {
            api(backupConfig.provider).download(backupConfig, backupFilePath, function (error, sourceStream) {
                if (error) return retryCallback(error);

                tarExtract(sourceStream, dataLayout, backupConfig.key || null, function (error, ps) {
                    if (error) return retryCallback(error);

                    ps.on('progress', function (progress) {
                        const transferred = Math.round(progress.transferred/1024/1024), speed = Math.round(progress.speed/1024/1024);
                        if (!transferred && !speed) return progressCallback({ message: 'Downloading' }); // 0M@0Mbps looks wrong
                        progressCallback({ message: `Downloading ${transferred}M@${speed}Mbps` });
                    });
                    ps.on('error', retryCallback);
                    ps.on('done', retryCallback);
                });
            });
        }, callback);
    } else {
        downloadDir(backupConfig, backupFilePath, dataLayout, progressCallback, function (error) {
            if (error) return callback(error);

            restoreFsMetadata(dataLayout, `${dataLayout.localRoot()}/fsmetadata.json`, callback);
        });
    }
}

function restore(backupConfig, backupId, progressCallback, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    const dataLayout = new DataLayout(paths.BOX_DATA_DIR, []);

    download(backupConfig, backupId, backupConfig.format, dataLayout, progressCallback, function (error) {
        if (error) return callback(error);

        debug('restore: download completed, importing database');

        database.importFromFile(`${dataLayout.localRoot()}/box.mysqldump`, function (error) {
            if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

            debug('restore: database imported');

            callback();
        });
    });
}

function restoreApp(app, addonsToRestore, restoreConfig, progressCallback, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof addonsToRestore, 'object');
    assert.strictEqual(typeof restoreConfig, 'object');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    const appDataDir = safe.fs.realpathSync(path.join(paths.APPS_DATA_DIR, app.id));
    if (!appDataDir) return callback(safe.error);
    const dataLayout = new DataLayout(appDataDir, app.dataDir ? [{ localDir: app.dataDir, remoteDir: 'data' }] : []);

    var startTime = new Date();

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        async.series([
            download.bind(null, backupConfig, restoreConfig.backupId, restoreConfig.backupFormat, dataLayout, progressCallback),
            addons.restoreAddons.bind(null, app, addonsToRestore)
        ], function (error) {
            debug('restoreApp: time: %s', (new Date() - startTime)/1000);

            callback(error);
        });
    });
}

function runBackupUpload(backupId, format, dataLayout, progressCallback, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof format, 'string');
    assert(dataLayout instanceof DataLayout, 'dataLayout must be a DataLayout');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    let result = '';

    shell.sudo(`backup-${backupId}`, [ BACKUP_UPLOAD_CMD, backupId, format, dataLayout.toString() ], { preserveEnv: true, ipc: true }, function (error) {
        if (error && (error.code === null /* signal */ || (error.code !== 0 && error.code !== 50))) { // backuptask crashed
            return callback(new BackupsError(BackupsError.INTERNAL_ERROR, 'Backuptask crashed'));
        } else if (error && error.code === 50) { // exited with error
            return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, result));
        }

        callback();
    }).on('message', function (message) {
        if (!message.result) return progressCallback(message);
        debug(`runBackupUpload: result - ${message}`);
        result = message.result;
    });
}

function getSnapshotInfo(id) {
    assert.strictEqual(typeof id, 'string');

    var contents = safe.fs.readFileSync(paths.SNAPSHOT_INFO_FILE, 'utf8');
    var info = safe.JSON.parse(contents);
    if (!info) return { };
    return info[id] || { };
}

function setSnapshotInfo(id, info, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof info, 'object');
    assert.strictEqual(typeof callback, 'function');

    var contents = safe.fs.readFileSync(paths.SNAPSHOT_INFO_FILE, 'utf8');
    var data = safe.JSON.parse(contents) || { };
    if (info) data[id] = info; else delete data[id];
    if (!safe.fs.writeFileSync(paths.SNAPSHOT_INFO_FILE, JSON.stringify(data, null, 4), 'utf8')) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, safe.error.message));

    callback();
}

function snapshotBox(progressCallback, callback) {
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    progressCallback({ message: 'Snapshotting box' });

    database.exportToFile(`${paths.BOX_DATA_DIR}/box.mysqldump`, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        return callback();
    });
}

function uploadBoxSnapshot(backupConfig, progressCallback, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    var startTime = new Date();

    snapshotBox(progressCallback, function (error) {
        if (error) return callback(error);

        const boxDataDir = safe.fs.realpathSync(paths.BOX_DATA_DIR);
        if (!boxDataDir) return callback(safe.error);

        const dataLayout = new DataLayout(boxDataDir, []);
        runBackupUpload('snapshot/box', backupConfig.format, dataLayout, progressCallback, function (error) {
            if (error) return callback(error);

            debug('uploadBoxSnapshot: time: %s secs', (new Date() - startTime)/1000);

            setSnapshotInfo('box', { timestamp: new Date().toISOString(), format: backupConfig.format }, callback);
        });
    });
}


function backupDone(apiConfig, backupId, appBackupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    if (apiConfig.provider !== 'caas') return callback();

    debug('[%s] backupDone: %s apps %j', backupId, backupId, appBackupIds);

    var url = config.apiServerOrigin() + '/api/v1/boxes/' + apiConfig.fqdn + '/backupDone';
    var data = {
        boxVersion: config.version(),
        backupId: backupId,
        appId: null,        // now unused
        appVersion: null,   // now unused
        appBackupIds: appBackupIds
    };

    superagent.post(url).send(data).query({ token: apiConfig.token }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));
        if (result.statusCode !== 200) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, result.text));

        return callback(null);
    });
}

function rotateBoxBackup(backupConfig, timestamp, appBackupIds, progressCallback, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof timestamp, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    var snapshotInfo = getSnapshotInfo('box');
    if (!snapshotInfo) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, 'Snapshot info missing or corrupt'));

    var snapshotTime = snapshotInfo.timestamp.replace(/[T.]/g, '-').replace(/[:Z]/g,'');
    var backupId = util.format('%s/box_%s_v%s', timestamp, snapshotTime, config.version());
    const format = backupConfig.format;

    debug(`Rotating box backup to id ${backupId}`);

    backupdb.add({ id: backupId, version: config.version(), type: backupdb.BACKUP_TYPE_BOX, dependsOn: appBackupIds, manifest: null, format: format }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var copy = api(backupConfig.provider).copy(backupConfig, getBackupFilePath(backupConfig, 'snapshot/box', format), getBackupFilePath(backupConfig, backupId, format));
        copy.on('progress', (message) => progressCallback({ message }));
        copy.on('done', function (copyBackupError) {
            const state = copyBackupError ? backupdb.BACKUP_STATE_ERROR : backupdb.BACKUP_STATE_NORMAL;

            backupdb.update(backupId, { state: state }, function (error) {
                if (copyBackupError) return callback(copyBackupError);
                if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

                debug(`Rotated box backup successfully as id ${backupId}`);

                backupDone(backupConfig, backupId, appBackupIds, function (error) {
                    if (error) return callback(error);

                    callback(null, backupId);
                });
            });
        });
    });
}

function backupBoxWithAppBackupIds(appBackupIds, timestamp, progressCallback, callback) {
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof timestamp, 'string');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        uploadBoxSnapshot(backupConfig, progressCallback, function (error) {
            if (error) return callback(error);

            rotateBoxBackup(backupConfig, timestamp, appBackupIds, progressCallback, callback);
        });
    });
}

function canBackupApp(app) {
    // only backup apps that are installed or pending configure or called from apptask. Rest of them are in some
    // state not good for consistent backup (i.e addons may not have been setup completely)
    return (app.installationState === appdb.ISTATE_INSTALLED && app.health === appdb.HEALTH_HEALTHY) ||
            app.installationState === appdb.ISTATE_PENDING_CONFIGURE ||
            app.installationState === appdb.ISTATE_PENDING_BACKUP ||  // called from apptask
            app.installationState === appdb.ISTATE_PENDING_UPDATE; // called from apptask
}

function snapshotApp(app, progressCallback, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    progressCallback({ message: `Snapshotting app ${app.fqdn}` });

    if (!safe.fs.writeFileSync(path.join(paths.APPS_DATA_DIR, app.id + '/config.json'), JSON.stringify(apps.getAppConfig(app)))) {
        return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, 'Error creating config.json: ' + safe.error.message));
    }

    addons.backupAddons(app, app.manifest.addons, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        return callback(null);
    });
}

function rotateAppBackup(backupConfig, app, timestamp, progressCallback, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof timestamp, 'string');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    var snapshotInfo = getSnapshotInfo(app.id);
    if (!snapshotInfo) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, 'Snapshot info missing or corrupt'));

    var snapshotTime = snapshotInfo.timestamp.replace(/[T.]/g, '-').replace(/[:Z]/g,'');
    var manifest = snapshotInfo.restoreConfig ? snapshotInfo.restoreConfig.manifest : snapshotInfo.manifest; // compat
    var backupId = util.format('%s/app_%s_%s_v%s', timestamp, app.id, snapshotTime, manifest.version);
    const format = backupConfig.format;

    debug(`Rotating app backup of ${app.id} to id ${backupId}`);

    backupdb.add({ id: backupId, version: manifest.version, type: backupdb.BACKUP_TYPE_APP, dependsOn: [ ], manifest: manifest, format: format }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var copy = api(backupConfig.provider).copy(backupConfig, getBackupFilePath(backupConfig, `snapshot/app_${app.id}`, format), getBackupFilePath(backupConfig, backupId, format));
        copy.on('progress', (message) => progressCallback({ message }));
        copy.on('done', function (copyBackupError) {
            const state = copyBackupError ? backupdb.BACKUP_STATE_ERROR : backupdb.BACKUP_STATE_NORMAL;

            backupdb.update(backupId, { state: state }, function (error) {
                if (copyBackupError) return callback(copyBackupError);
                if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

                debug(`Rotated app backup of ${app.id} successfully to id ${backupId}`);

                callback(null, backupId);
            });
        });
    });
}

function uploadAppSnapshot(backupConfig, app, progressCallback, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    if (!canBackupApp(app)) return callback(); // nothing to do

    var startTime = new Date();

    snapshotApp(app, progressCallback, function (error) {
        if (error) return callback(error);

        const backupId = util.format('snapshot/app_%s', app.id);
        const appDataDir = safe.fs.realpathSync(path.join(paths.APPS_DATA_DIR, app.id));
        if (!appDataDir) return callback(safe.error);

        const dataLayout = new DataLayout(appDataDir, app.dataDir ? [{ localDir: app.dataDir, remoteDir: 'data' }] : []);

        runBackupUpload(backupId, backupConfig.format, dataLayout, progressCallback, function (error) {
            if (error) return callback(error);

            debugApp(app, 'uploadAppSnapshot: %s done time: %s secs', backupId, (new Date() - startTime)/1000);

            setSnapshotInfo(app.id, { timestamp: new Date().toISOString(), manifest: app.manifest, format: backupConfig.format }, callback);
        });
    });
}

function backupAppWithTimestamp(app, timestamp, progressCallback, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof timestamp, 'string');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    if (!canBackupApp(app)) return callback(); // nothing to do

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        uploadAppSnapshot(backupConfig, app, progressCallback, function (error) {
            if (error) return callback(error);

            rotateAppBackup(backupConfig, app, timestamp, progressCallback, callback);
        });
    });
}

function backupApp(app, progressCallback, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    const timestamp = (new Date()).toISOString().replace(/[T.]/g, '-').replace(/[:Z]/g,'');

    debug(`backupApp - Backing up ${app.fqdn} with timestamp ${timestamp}`);

    backupAppWithTimestamp(app, timestamp, progressCallback, callback);
}

// this function expects you to have a lock. Unlike other progressCallback this also has a progress field
function backupBoxAndApps(progressCallback, callback) {
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    var timestamp = (new Date()).toISOString().replace(/[T.]/g, '-').replace(/[:Z]/g,'');

    apps.getAll(function (error, allApps) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        let percent = 1;
        let step = 100/(allApps.length+2);

        async.mapSeries(allApps, function iterator(app, iteratorCallback) {
            progressCallback({ percent: percent, message: `Backing up ${app.fqdn}` });
            percent += step;

            if (!app.enableBackup) {
                debug(`Skipped backup ${app.fqdn}`);
                return iteratorCallback(null, null); // nothing to backup
            }

            backupAppWithTimestamp(app, timestamp, (progress) => progressCallback({ percent: percent, message: progress.message }), function (error, backupId) {
                if (error && error.reason !== BackupsError.BAD_STATE) {
                    debugApp(app, 'Unable to backup', error);
                    return iteratorCallback(error);
                }

                debugApp(app, 'Backed up');

                iteratorCallback(null, backupId || null); // clear backupId if is in BAD_STATE and never backed up
            });
        }, function appsBackedUp(error, backupIds) {
            if (error) return callback(error);

            backupIds = backupIds.filter(function (id) { return id !== null; }); // remove apps in bad state that were never backed up

            progressCallback({ percent: percent, message: 'Backing up system data' });
            percent += step;

            backupBoxWithAppBackupIds(backupIds, timestamp, (progress) => progressCallback({ percent: percent, message: progress.message }), callback);
        });
    });
}

function startBackupTask(auditSource, callback) {
    let error = locker.lock(locker.OP_FULL_BACKUP);
    if (error) return callback(new BackupsError(BackupsError.BAD_STATE, `Cannot backup now: ${error.message}`));

    let task = tasks.startTask(tasks.TASK_BACKUP, []);
    task.on('error', (error) => callback(new BackupsError(BackupsError.INTERNAL_ERROR, error)));
    task.on('start', (taskId) => {
        eventlog.add(eventlog.ACTION_BACKUP_START, auditSource, { taskId });
        callback(null, taskId);
    });
    task.on('finish', (error, result) => {
        locker.unlock(locker.OP_FULL_BACKUP);

        if (error) mailer.backupFailed(error);

        eventlog.add(eventlog.ACTION_BACKUP_FINISH, auditSource, { errorMessage: error ? error.message : null, backupId: result });
    });
}

function ensureBackup(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');

    debug('ensureBackup: %j', auditSource);

    getByStatePaged(backupdb.BACKUP_STATE_NORMAL, 1, 1, function (error, backups) {
        if (error) {
            debug('Unable to list backups', error);
            return callback(error);
        }

        settings.getBackupConfig(function (error, backupConfig) {
            if (error) return callback(error);

            if (backups.length !== 0 && (new Date() - new Date(backups[0].creationTime) < (backupConfig.intervalSecs - 3600) * 1000)) { // adjust 1 hour
                debug('Previous backup was %j, no need to backup now', backups[0]);
                return callback(null);
            }

            startBackupTask(auditSource, callback);
        });
    });
}

function cleanupBackup(backupConfig, backup, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backup, 'object');
    assert.strictEqual(typeof callback, 'function');

    var backupFilePath = getBackupFilePath(backupConfig, backup.id, backup.format);

    function done(error) {
        if (error) {
            debug('cleanupBackup: error removing backup %j : %s', backup, error.message);
            return callback();
        }

        // prune empty directory if possible
        api(backupConfig.provider).remove(backupConfig, path.dirname(backupFilePath), function (error) {
            if (error) debug('cleanupBackup: unable to prune backup directory %s : %s', path.dirname(backupFilePath), error.message);

            backupdb.del(backup.id, function (error) {
                if (error) debug('cleanupBackup: error removing from database', error);
                else debug('cleanupBackup: removed %s', backup.id);

                callback();
            });
        });
    }

    if (backup.format ==='tgz') {
        api(backupConfig.provider).remove(backupConfig, backupFilePath, done);
    } else {
        var events = api(backupConfig.provider).removeDir(backupConfig, backupFilePath);
        events.on('progress', function (detail) { debug(`cleanupBackup: ${detail}`); });
        events.on('done', done);
    }
}

function cleanupAppBackups(backupConfig, referencedAppBackups, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert(Array.isArray(referencedAppBackups));
    assert.strictEqual(typeof callback, 'function');

    const now = new Date();
    let removedAppBackups = [];

    // we clean app backups of any state because the ones to keep are determined by the box cleanup code
    backupdb.getByTypePaged(backupdb.BACKUP_TYPE_APP, 1, 1000, function (error, appBackups) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        async.eachSeries(appBackups, function iterator(appBackup, iteratorDone) {
            if (referencedAppBackups.indexOf(appBackup.id) !== -1) return iteratorDone();
            if ((now - appBackup.creationTime) < (backupConfig.retentionSecs * 1000)) return iteratorDone();

            debug('cleanupAppBackups: removing %s', appBackup.id);

            removedAppBackups.push(appBackup.id);
            cleanupBackup(backupConfig, appBackup, iteratorDone);
        }, function () {
            debug('cleanupAppBackups: done');

            callback(null, removedAppBackups);
        });
    });
}

function cleanupBoxBackups(backupConfig, auditSource, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    const now = new Date();
    let referencedAppBackups = [], removedBoxBackups = [];

    backupdb.getByTypePaged(backupdb.BACKUP_TYPE_BOX, 1, 1000, function (error, boxBackups) {
        if (error) return callback(error);

        if (boxBackups.length === 0) return callback(null, { removedBoxBackups, referencedAppBackups });

        // search for the first valid backup
        var i;
        for (i = 0; i < boxBackups.length; i++) {
            if (boxBackups[i].state === backupdb.BACKUP_STATE_NORMAL) break;
        }

        // keep the first valid backup
        if (i !== boxBackups.length) {
            debug('cleanupBoxBackups: preserving box backup %s (%j)', boxBackups[i].id, boxBackups[i].dependsOn);
            referencedAppBackups = boxBackups[i].dependsOn;
            boxBackups.splice(i, 1);
        } else {
            debug('cleanupBoxBackups: no box backup to preserve');
        }

        async.eachSeries(boxBackups, function iterator(boxBackup, iteratorNext) {
            // TODO: errored backups should probably be cleaned up before retention time, but we will
            // have to be careful not to remove any backup currently being created
            if ((now - boxBackup.creationTime) < (backupConfig.retentionSecs * 1000)) {
                referencedAppBackups = referencedAppBackups.concat(boxBackup.dependsOn);
                return iteratorNext();
            }

            debug('cleanupBoxBackups: removing %s', boxBackup.id);

            removedBoxBackups.push(boxBackup.id);
            cleanupBackup(backupConfig, boxBackup, iteratorNext);
        }, function () {
            debug('cleanupBoxBackups: done');

            callback(null, { removedBoxBackups, referencedAppBackups });
        });
    });
}

function cleanupCacheFilesSync() {
    var files = safe.fs.readdirSync(path.join(paths.BACKUP_INFO_DIR));
    if (!files) return;

    files.filter(function (f) { return f.endsWith('.sync.cache'); }).forEach(function (f) {
        safe.fs.unlinkSync(path.join(paths.BACKUP_INFO_DIR, f));
    });
}

// removes the snapshots of apps that have been uninstalled
function cleanupSnapshots(backupConfig, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    var contents = safe.fs.readFileSync(paths.SNAPSHOT_INFO_FILE, 'utf8');
    var info = safe.JSON.parse(contents);
    if (!info) return callback();

    delete info.box;
    async.eachSeries(Object.keys(info), function (appId, iteratorDone) {
        apps.get(appId, function (error /*, app */) {
            if (!error || error.reason !== AppsError.NOT_FOUND) return iteratorDone();

            function done(/* ignoredError */) {
                safe.fs.unlinkSync(path.join(paths.BACKUP_INFO_DIR, `${appId}.sync.cache`));
                safe.fs.unlinkSync(path.join(paths.BACKUP_INFO_DIR, `${appId}.sync.cache.new`));

                setSnapshotInfo(appId, null, function (/* ignoredError */) {
                    debug('cleanupSnapshots: cleaned up snapshot of app id %s', appId);

                    iteratorDone();
                });
            }

            if (info[appId].format ==='tgz') {
                api(backupConfig.provider).remove(backupConfig, getBackupFilePath(backupConfig, `snapshot/app_${appId}`, info[appId].format), done);
            } else {
                var events = api(backupConfig.provider).removeDir(backupConfig, getBackupFilePath(backupConfig, `snapshot/app_${appId}`, info[appId].format));
                events.on('progress', function (detail) { debug(`cleanupSnapshots: ${detail}`); });
                events.on('done', done);
            }
        });
    }, function () {
        debug('cleanupSnapshots: done');

        callback();
    });
}

function cleanup(auditSource, progressCallback, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(error);

        if (backupConfig.retentionSecs < 0) {
            debug('cleanup: keeping all backups');
            return callback(null, {});
        }

        progressCallback({ percent: 10, message: 'Cleaning box backups' });

        cleanupBoxBackups(backupConfig, auditSource, function (error, result) {
            if (error) return callback(error);

            progressCallback({ percent: 40, message: 'Cleaning app backups' });

            cleanupAppBackups(backupConfig, result.referencedAppBackups, function (error, removedAppBackups) {
                if (error) return callback(error);

                progressCallback({ percent: 90, message: 'Cleaning snapshots' });

                cleanupSnapshots(backupConfig, function (error) {
                    if (error) return callback(error);

                    callback(null, { removedBoxBackups: result.removedBoxBackups, removedAppBackups: removedAppBackups });
                });
            });
        });
    });
}

function startCleanupTask(auditSource, callback) {
    let task = tasks.startTask(tasks.TASK_CLEAN_BACKUPS, [ auditSource ]);
    task.on('error', (error) => callback(new BackupsError(BackupsError.INTERNAL_ERROR, error)));
    task.on('start', (taskId) => {
        eventlog.add(eventlog.ACTION_BACKUP_CLEANUP_START, auditSource, { taskId });
        callback(null, taskId);
    });
    task.on('finish', (error, result) => { // result is { removedBoxBackups, removedAppBackups }
        eventlog.add(eventlog.ACTION_BACKUP_CLEANUP_FINISH, auditSource, {
            errorMessage: error ? error.message : null,
            removedBoxBackups: result ? result.removedBoxBackups : [],
            removedAppBackups: result ? result.removedAppBackups : []
        });
    });
}
