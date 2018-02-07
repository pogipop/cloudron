'use strict';

exports = module.exports = {
    BackupsError: BackupsError,

    testConfig: testConfig,

    getByStatePaged: getByStatePaged,
    getByAppIdPaged: getByAppIdPaged,

    get: get,

    ensureBackup: ensureBackup,

    backup: backup,
    restore: restore,

    backupApp: backupApp,
    restoreApp: restoreApp,

    backupBoxAndApps: backupBoxAndApps,

    upload: upload,

    cleanup: cleanup,
    cleanupCacheFilesSync: cleanupCacheFilesSync,

    // for testing
    _getBackupFilePath: getBackupFilePath,
    _createTarPackStream: createTarPackStream,
    _tarExtract: tarExtract,
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
    debug = require('debug')('box:backups'),
    eventlog = require('./eventlog.js'),
    fs = require('fs'),
    locker = require('./locker.js'),
    mailer = require('./mailer.js'),
    mkdirp = require('mkdirp'),
    once = require('once'),
    path = require('path'),
    paths = require('./paths.js'),
    progress = require('./progress.js'),
    progressStream = require('progress-stream'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    settings = require('./settings.js'),
    syncer = require('./syncer.js'),
    tar = require('tar-fs'),
    util = require('util'),
    zlib = require('zlib');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

var BACKUPTASK_CMD = path.join(__dirname, 'backuptask.js');

function debugApp(app) {
    assert(!app || typeof app === 'object');

    var prefix = app ? app.intrinsicFqdn : '(no app)';
    debug(prefix + ' ' + util.format.apply(util, Array.prototype.slice.call(arguments, 1)));
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
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new BackupsError(BackupsError.NOT_FOUND, error));
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

function log(detail) {
    safe.fs.appendFileSync(paths.BACKUP_LOG_FILE, detail + '\n', 'utf8');
    progress.setDetail(progress.BACKUP, detail);
}

function createTarPackStream(sourceDir, key) {
    assert.strictEqual(typeof sourceDir, 'string');
    assert(key === null || typeof key === 'string');

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
    var ps = progressStream({ time: 10000 }); // display a progress every 10 seconds

    pack.on('error', function (error) {
        debug('createTarPackStream: tar stream error.', error);
        ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    gzip.on('error', function (error) {
        debug('createTarPackStream: gzip stream error.', error);
        ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    ps.on('progress', function(progress) {
        debug('createTarPackStream: %s@%s', Math.round(progress.transferred/1024/1024) + 'M', Math.round(progress.speed/1024/1024) + 'Mbps');
    });

    if (key !== null) {
        var encrypt = crypto.createCipher('aes-256-cbc', key);
        encrypt.on('error', function (error) {
            debug('createTarPackStream: encrypt stream error.', error);
            ps.emit('error', new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });
        return pack.pipe(gzip).pipe(encrypt).pipe(ps);
    } else {
        return pack.pipe(gzip).pipe(ps);
    }
}

function sync(backupConfig, backupId, dataDir, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof dataDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    syncer.sync(dataDir, function processTask(task, iteratorCallback) {
        debug('sync: processing task: %j', task);
        var backupFilePath = path.join(getBackupFilePath(backupConfig, backupId, backupConfig.format), task.path);

        if (task.operation === 'removedir') {
            safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, `Removing directory ${task.path}`);
            return api(backupConfig.provider).removeDir(backupConfig, backupFilePath)
                .on('progress', function (detail) {
                    debug(`sync: ${detail}`);
                    safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, detail);
                })
                .on('done', iteratorCallback);
        } else if (task.operation === 'remove') {
            safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, `Removing ${task.path}`);
            return api(backupConfig.provider).remove(backupConfig, backupFilePath, iteratorCallback);
        }

        var retryCount = 0;
        async.retry({ times: 5, interval: 20000 }, function (retryCallback) {
            ++retryCount;
            debug(`${task.operation} ${task.path} try ${retryCount}`);
            if (task.operation === 'add') {
                safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, `Adding ${task.path}`);
                var stream = fs.createReadStream(path.join(dataDir, task.path));
                stream.on('error', function () { return retryCallback(); }); // ignore error if file disappears
                api(backupConfig.provider).upload(backupConfig, backupFilePath, stream, retryCallback);
            }
        }, iteratorCallback);
    }, 10 /* concurrency */, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        callback();
    });
}

function saveFsMetadata(appDataDir, callback) {
    assert.strictEqual(typeof appDataDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    var emptyDirs = safe.child_process.execSync('find . -type d -empty', { cwd: `${appDataDir}`, encoding: 'utf8' });
    if (emptyDirs === null) return callback(safe.error);

    var execFiles = safe.child_process.execSync('find . -type f -executable', { cwd: `${appDataDir}`, encoding: 'utf8' });
    if (execFiles === null) return callback(safe.error);

    var metadata = {
        emptyDirs: emptyDirs.length === 0 ? [ ] : emptyDirs.trim().split('\n'),
        execFiles: execFiles.length === 0 ? [ ] : execFiles.trim().split('\n')
    };

    if (!safe.fs.writeFileSync(`${appDataDir}/fsmetadata.json`, JSON.stringify(metadata, null, 4))) return callback(safe.error);

    callback();
}

// this function is called via backuptask (since it needs root to traverse app's directory)
function upload(backupId, format, dataDir, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof format, 'string');
    assert.strictEqual(typeof dataDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    debug('upload: id %s format %s dataDir %s', backupId, format, dataDir);

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        if (format === 'tgz') {
            async.retry({ times: 5, interval: 20000 }, function (retryCallback) {
                var tarStream = createTarPackStream(dataDir, backupConfig.key || null);
                tarStream.on('error', retryCallback); // already returns BackupsError

                api(backupConfig.provider).upload(backupConfig, getBackupFilePath(backupConfig, backupId, format), tarStream, retryCallback);
            }, callback);
        } else {
            async.series([
                saveFsMetadata.bind(null, dataDir),
                sync.bind(null, backupConfig, backupId, dataDir)
            ], callback);
        }
    });
}

function tarExtract(inStream, destination, key, callback) {
    assert.strictEqual(typeof inStream, 'object');
    assert.strictEqual(typeof destination, 'string');
    assert(key === null || typeof key === 'string');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    var gunzip = zlib.createGunzip({});
    var ps = progressStream({ time: 10000 }); // display a progress every 10 seconds
    var extract = tar.extract(destination);

    inStream.on('error', function (error) {
        debug('tarExtract: input stream error.', error);
        callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    ps.on('progress', function(progress) {
        debug('tarExtract: %s@%s', Math.round(progress.transferred/1024/1024) + 'M', Math.round(progress.speed/1024/1024) + 'Mbps');
    });

    gunzip.on('error', function (error) {
        debug('tarExtract: gunzip stream error.', error);
        callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    extract.on('error', function (error) {
        debug('tarExtract: extract stream error.', error);
        callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
    });

    extract.on('finish', function () {
        debug('tarExtract: done.');
        callback(null);
    });

    if (key !== null) {
        var decrypt = crypto.createDecipher('aes-256-cbc', key);
        decrypt.on('error', function (error) {
            debug('tarExtract: decrypt stream error.', error);
            callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));
        });
        inStream.pipe(ps).pipe(decrypt).pipe(gunzip).pipe(extract);
    } else {
        inStream.pipe(ps).pipe(gunzip).pipe(extract);
    }
}

function restoreFsMetadata(appDataDir, callback) {
    assert.strictEqual(typeof appDataDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    log('Recreating empty directories');

    var metadataJson = safe.fs.readFileSync(path.join(appDataDir, 'fsmetadata.json'), 'utf8');
    if (metadataJson === null) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, 'Error loading fsmetadata.txt:' + safe.error.message));
    var metadata = safe.JSON.parse(metadataJson);
    if (metadata === null) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, 'Error parsing fsmetadata.txt:' + safe.error.message));

    async.eachSeries(metadata.emptyDirs, function createPath(emptyDir, iteratorDone) {
        mkdirp(path.join(appDataDir, emptyDir), iteratorDone);
    }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, `unable to create path: ${error.message}`));

        async.eachSeries(metadata.execFiles, function createPath(execFile, iteratorDone) {
            fs.chmod(path.join(appDataDir, execFile), parseInt('0755', 8), iteratorDone);
        }, function (error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, `unable to chmod: ${error.message}`));

            callback();
        });
    });
}

function download(backupConfig, backupId, format, dataDir, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof format, 'string');
    assert.strictEqual(typeof dataDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    safe.fs.unlinkSync(paths.BACKUP_LOG_FILE); // start fresh log file

    log(`Downloading ${backupId} of format ${format} to ${dataDir}`);

    if (format === 'tgz') {
        api(backupConfig.provider).download(backupConfig, getBackupFilePath(backupConfig, backupId, format), function (error, sourceStream) {
            if (error) return callback(error);

            tarExtract(sourceStream, dataDir, backupConfig.key || null, callback);
        });
    } else {
        var events = api(backupConfig.provider).downloadDir(backupConfig, getBackupFilePath(backupConfig, backupId, format), dataDir);
        events.on('progress', log);
        events.on('done', function (error) {
            if (error) return callback(error);

            restoreFsMetadata(dataDir, callback);
        });
    }
}

function restore(backupConfig, backupId, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    download(backupConfig, backupId, backupConfig.format, paths.BOX_DATA_DIR, function (error) {
        if (error) return callback(error);

        database.importFromFile(`${paths.BOX_DATA_DIR}/box.mysqldump`, function (error) {
            if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

            callback();
        });
    });
}

function restoreApp(app, addonsToRestore, restoreConfig, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof addonsToRestore, 'object');
    assert.strictEqual(typeof restoreConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    var appDataDir = safe.fs.realpathSync(path.join(paths.APPS_DATA_DIR, app.id));

    var startTime = new Date();

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        async.series([
            download.bind(null, backupConfig, restoreConfig.backupId, restoreConfig.backupFormat, appDataDir),
            addons.restoreAddons.bind(null, app, addonsToRestore)
        ], function (error) {
            debug('restoreApp: time: %s', (new Date() - startTime)/1000);

            callback(error);
        });
    });
}

function runBackupTask(backupId, format, dataDir, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof format, 'string');
    assert.strictEqual(typeof dataDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    var killTimerId = null, progressTimerId = null;

    var logStream = fs.createWriteStream(paths.BACKUP_LOG_FILE, { flags: 'a' });
    var cp = shell.sudo(`backup-${backupId}`, [ BACKUPTASK_CMD, backupId, format, dataDir ], { env: process.env, logStream: logStream }, function (error) {
        clearTimeout(killTimerId);
        clearInterval(progressTimerId);

        cp = null;

        if (error && (error.code === null /* signal */ || (error.code !== 0 && error.code !== 50))) { // backuptask crashed
            return callback(new BackupsError(BackupsError.INTERNAL_ERROR, 'Backuptask crashed'));
        } else if (error && error.code === 50) { // exited with error
            var result = safe.fs.readFileSync(paths.BACKUP_RESULT_FILE, 'utf8') || safe.error.message;
            return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, result));
        }

        callback();
    });

    progressTimerId = setInterval(function () {
        var result = safe.fs.readFileSync(paths.BACKUP_RESULT_FILE, 'utf8');
        if (result) progress.setDetail(progress.BACKUP, result);
    }, 1000); // every second

    killTimerId = setTimeout(function () {
        debug('runBackupTask: backup task taking too long. killing');
        cp.kill();
    }, 4 * 60 * 60 * 1000); // 4 hours

    logStream.on('error', function (error) {
        debug('runBackupTask: error in logging stream', error);
        cp.kill();
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

function snapshotBox(callback) {
    assert.strictEqual(typeof callback, 'function');

    log('Snapshotting box');

    database.exportToFile(`${paths.BOX_DATA_DIR}/box.mysqldump`, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        return callback();
    });
}

function uploadBoxSnapshot(backupConfig, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    var startTime = new Date();

    snapshotBox(function (error) {
        if (error) return callback(error);

        runBackupTask('snapshot/box', backupConfig.format, paths.BOX_DATA_DIR, function (error) {
            if (error) return callback(error);

            debug('uploadBoxSnapshot: time: %s secs', (new Date() - startTime)/1000);

            setSnapshotInfo('box', { timestamp: new Date().toISOString(), format: backupConfig.format }, callback);
        });
    });
}

function rotateBoxBackup(backupConfig, timestamp, appBackupIds, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof timestamp, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    var snapshotInfo = getSnapshotInfo('box');
    if (!snapshotInfo) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, 'Snapshot info missing or corrupt'));

    var snapshotTime = snapshotInfo.timestamp.replace(/[T.]/g, '-').replace(/[:Z]/g,'');
    var backupId = util.format('%s/box_%s_v%s', timestamp, snapshotTime, config.version());
    const format = backupConfig.format;

    log(`Rotating box backup to id ${backupId}`);

    backupdb.add({ id: backupId, version: config.version(), type: backupdb.BACKUP_TYPE_BOX, dependsOn: appBackupIds, manifest: null, format: format }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var copy = api(backupConfig.provider).copy(backupConfig, getBackupFilePath(backupConfig, 'snapshot/box', format), getBackupFilePath(backupConfig, backupId, format));
        copy.on('progress', log);
        copy.on('done', function (copyBackupError) {
            const state = copyBackupError ? backupdb.BACKUP_STATE_ERROR : backupdb.BACKUP_STATE_NORMAL;

            backupdb.update(backupId, { state: state }, function (error) {
                if (copyBackupError) return callback(copyBackupError);
                if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

                log(`Rotated box backup successfully as id ${backupId}`);

                // FIXME this is only needed for caas, hopefully we can remove that in the future
                api(backupConfig.provider).backupDone(backupConfig, backupId, appBackupIds, function (error) {
                    if (error) return callback(error);

                    callback(null, backupId);
                });
            });
        });
    });
}

function backupBoxWithAppBackupIds(appBackupIds, timestamp, callback) {
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof timestamp, 'string');
    assert.strictEqual(typeof callback, 'function');

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        uploadBoxSnapshot(backupConfig, function (error) {
            if (error) return callback(error);

            rotateBoxBackup(backupConfig, timestamp, appBackupIds, callback);
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

function snapshotApp(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    log(`Snapshotting app ${app.id}`);

    if (!safe.fs.writeFileSync(path.join(paths.APPS_DATA_DIR, app.id + '/config.json'), JSON.stringify(apps.getAppConfig(app)))) {
        return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, 'Error creating config.json: ' + safe.error.message));
    }

    addons.backupAddons(app, app.manifest.addons, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        return callback(null);
    });
}

function rotateAppBackup(backupConfig, app, timestamp, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof timestamp, 'string');
    assert.strictEqual(typeof callback, 'function');

    var snapshotInfo = getSnapshotInfo(app.id);
    if (!snapshotInfo) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, 'Snapshot info missing or corrupt'));

    var snapshotTime = snapshotInfo.timestamp.replace(/[T.]/g, '-').replace(/[:Z]/g,'');
    var manifest = snapshotInfo.restoreConfig ? snapshotInfo.restoreConfig.manifest : snapshotInfo.manifest; // compat
    var backupId = util.format('%s/app_%s_%s_v%s', timestamp, app.id, snapshotTime, manifest.version);
    const format = backupConfig.format;

    log(`Rotating app backup of ${app.id} to id ${backupId}`);

    backupdb.add({ id: backupId, version: manifest.version, type: backupdb.BACKUP_TYPE_APP, dependsOn: [ ], manifest: manifest, format: format }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var copy = api(backupConfig.provider).copy(backupConfig, getBackupFilePath(backupConfig, `snapshot/app_${app.id}`, format), getBackupFilePath(backupConfig, backupId, format));
        copy.on('progress', log);
        copy.on('done', function (copyBackupError) {
            const state = copyBackupError ? backupdb.BACKUP_STATE_ERROR : backupdb.BACKUP_STATE_NORMAL;

            backupdb.update(backupId, { state: state }, function (error) {
                if (copyBackupError) return callback(copyBackupError);
                if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

                log(`Rotated app backup of ${app.id} successfully to id ${backupId}`);

                callback(null, backupId);
            });
        });
    });
}

function uploadAppSnapshot(backupConfig, app, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!canBackupApp(app)) return callback(); // nothing to do

    var startTime = new Date();

    snapshotApp(app, function (error) {
        if (error) return callback(error);

        var backupId = util.format('snapshot/app_%s', app.id);
        var appDataDir = safe.fs.realpathSync(path.join(paths.APPS_DATA_DIR, app.id));
        runBackupTask(backupId, backupConfig.format, appDataDir, function (error) {
            if (error) return callback(error);

            debugApp(app, 'uploadAppSnapshot: %s done time: %s secs', backupId, (new Date() - startTime)/1000);

            setSnapshotInfo(app.id, { timestamp: new Date().toISOString(), manifest: app.manifest, format: backupConfig.format }, callback);
        });
    });
}

function backupAppWithTimestamp(app, timestamp, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof timestamp, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!canBackupApp(app)) return callback(); // nothing to do

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        uploadAppSnapshot(backupConfig, app, function (error) {
            if (error) return callback(error);

            rotateAppBackup(backupConfig, app, timestamp, callback);
        });
    });
}

function backupApp(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    const timestamp = (new Date()).toISOString().replace(/[T.]/g, '-').replace(/[:Z]/g,'');
    safe.fs.unlinkSync(paths.BACKUP_LOG_FILE); // start fresh log file

    progress.set(progress.BACKUP, 10,  'Backing up ' + app.intrinsicFqdn);

    backupAppWithTimestamp(app, timestamp, function (error) {
        progress.set(progress.BACKUP, 100, error ? error.message : '');

        callback(error);
    });
}

// this function expects you to have a lock
function backupBoxAndApps(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');

    callback = callback || NOOP_CALLBACK;

    var timestamp = (new Date()).toISOString().replace(/[T.]/g, '-').replace(/[:Z]/g,'');
    safe.fs.unlinkSync(paths.BACKUP_LOG_FILE); // start fresh log file

    eventlog.add(eventlog.ACTION_BACKUP_START, auditSource, { });

    apps.getAll(function (error, allApps) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var processed = 1;
        var step = 100/(allApps.length+2);

        async.mapSeries(allApps, function iterator(app, iteratorCallback) {
            progress.set(progress.BACKUP, step * processed,  'Backing up ' + app.intrinsicFqdn);

            ++processed;

            if (!app.enableBackup) {
                progress.set(progress.BACKUP, step * processed, 'Skipped backup ' + app.intrinsicFqdn);
                return iteratorCallback(null, null); // nothing to backup
            }

            backupAppWithTimestamp(app, timestamp, function (error, backupId) {
                if (error && error.reason !== BackupsError.BAD_STATE) {
                    debugApp(app, 'Unable to backup', error);
                    return iteratorCallback(error);
                }

                progress.set(progress.BACKUP, step * processed, 'Backed up ' + app.intrinsicFqdn);

                iteratorCallback(null, backupId || null); // clear backupId if is in BAD_STATE and never backed up
            });
        }, function appsBackedUp(error, backupIds) {
            if (error) {
                progress.set(progress.BACKUP, 100, error.message);
                return callback(error);
            }

            backupIds = backupIds.filter(function (id) { return id !== null; }); // remove apps in bad state that were never backed up

            progress.set(progress.BACKUP, step * processed, 'Backing up system data');

            backupBoxWithAppBackupIds(backupIds, timestamp, function (error, backupId) {
                progress.set(progress.BACKUP, 100, error ? error.message : '');

                eventlog.add(eventlog.ACTION_BACKUP_FINISH, auditSource, { errorMessage: error ? error.message : null, backupId: backupId, timestamp: timestamp });

                callback(error, backupId);
            });
        });
    });
}

function backup(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    var error = locker.lock(locker.OP_FULL_BACKUP);
    if (error) return callback(new BackupsError(BackupsError.BAD_STATE, error.message));

    var startTime = new Date();
    progress.set(progress.BACKUP, 0, 'Starting'); // ensure tools can 'wait' on progress

    backupBoxAndApps(auditSource, function (error) { // start the backup operation in the background
        if (error) {
            debug('backup failed.', error);
            mailer.backupFailed(error);
        }

        locker.unlock(locker.OP_FULL_BACKUP);

        debug('backup took %s seconds', (new Date() - startTime)/1000);
    });

    callback(null);
}

function ensureBackup(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');

    debug('ensureBackup: %j', auditSource);

    getByStatePaged(backupdb.BACKUP_STATE_NORMAL, 1, 1, function (error, backups) {
        if (error) {
            debug('Unable to list backups', error);
            return callback(error); // no point trying to backup if appstore is down
        }

        if (backups.length !== 0 && (new Date() - new Date(backups[0].creationTime) < 23 * 60 * 60 * 1000)) { // ~1 day ago
            debug('Previous backup was %j, no need to backup now', backups[0]);
            return callback(null);
        }

        backup(auditSource, callback);
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

    // we clean app backups of any state because the ones to keep are determined by the box cleanup code
    backupdb.getByTypePaged(backupdb.BACKUP_TYPE_APP, 1, 1000, function (error, appBackups) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        async.eachSeries(appBackups, function iterator(backup, iteratorDone) {
            if (referencedAppBackups.indexOf(backup.id) !== -1) return iteratorDone();
            if ((now - backup.creationTime) < (backupConfig.retentionSecs * 1000)) return iteratorDone();

            debug('cleanupAppBackups: removing %s', backup.id);

            cleanupBackup(backupConfig, backup, iteratorDone);
        }, function () {
            debug('cleanupAppBackups: done');

            callback();
        });
    });
}

function cleanupBoxBackups(backupConfig, auditSource, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    const now = new Date();
    var referencedAppBackups = [];

    backupdb.getByTypePaged(backupdb.BACKUP_TYPE_BOX, 1, 1000, function (error, boxBackups) {
        if (error) return callback(error);

        if (boxBackups.length === 0) return callback(null, []);

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

        async.eachSeries(boxBackups, function iterator(backup, nextBackup) {
            // TODO: errored backups should probably be cleaned up before retention time, but we will
            // have to be careful not to remove any backup currently being created
            if ((now - backup.creationTime) < (backupConfig.retentionSecs * 1000)) {
                referencedAppBackups = referencedAppBackups.concat(backup.dependsOn);
                return nextBackup();
            }

            debug('cleanupBoxBackups: removing %s', backup.id);

            cleanupBackup(backupConfig, backup, nextBackup);
        }, function () {
            debug('cleanupBoxBackups: done');

            return callback(null, referencedAppBackups);
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

function cleanup(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert(!callback || typeof callback === 'function'); // callback is null when called from cronjob

    callback = callback || NOOP_CALLBACK;

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(error);

        if (backupConfig.retentionSecs < 0) {
            debug('cleanup: keeping all backups');
            return callback();
        }

        cleanupBoxBackups(backupConfig, auditSource, function (error, referencedAppBackups) {
            if (error) return callback(error);

            cleanupAppBackups(backupConfig, referencedAppBackups, function (error) {
                if (error) return callback(error);

                cleanupSnapshots(backupConfig, callback);
            });
        });
    });
}

