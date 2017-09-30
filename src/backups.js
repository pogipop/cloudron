'use strict';

exports = module.exports = {
    BackupsError: BackupsError,

    testConfig: testConfig,

    getByStatePaged: getByStatePaged,
    getByAppIdPaged: getByAppIdPaged,

    getRestoreConfig: getRestoreConfig,

    ensureBackup: ensureBackup,

    backup: backup,
    backupApp: backupApp,
    restoreApp: restoreApp,

    backupBoxAndApps: backupBoxAndApps,

    upload: upload,
    download: download,

    cleanup: cleanup,
    cleanupCacheFilesSync: cleanupCacheFilesSync,

    // for testing
    _getBackupFilePath: getBackupFilePath,
    _createTarPackStream: createTarPackStream,
    _tarExtract: tarExtract,
    _createEmptyDirs: createEmptyDirs,
    _saveEmptyDirs: saveEmptyDirs
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

    var prefix = app ? app.location : '(no app)';
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

function getRestoreConfig(backupId, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    backupdb.get(backupId, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new BackupsError(BackupsError.NOT_FOUND, error));
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));
        if (!result.restoreConfig)  return callback(new BackupsError(BackupsError.NOT_FOUND, error));

        callback(null, result.restoreConfig);
    });
}

function getBackupFilePath(backupConfig, backupId, format) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof format, 'string');

    if (format === 'tgz') {
        const fileType = backupConfig.key ? '.tar.gz.enc' : '.tar.gz';
        return path.join(backupConfig.prefix || backupConfig.backupFolder, backupId+fileType);
    } else {
        return path.join(backupConfig.prefix || backupConfig.backupFolder, backupId);
    }
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

        if (task.operation === 'add') {
            safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, 'Adding ' + task.path);
            var stream = fs.createReadStream(path.join(dataDir, task.path));
            stream.on('error', function () { return iteratorCallback(); }); // ignore error if file disappears
            api(backupConfig.provider).upload(backupConfig, backupFilePath, stream, iteratorCallback);
        } else if (task.operation === 'remove') {
            safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, 'Removing ' + task.path);
            api(backupConfig.provider).remove(backupConfig, backupFilePath, iteratorCallback);
        } else if (task.operation === 'removedir') {
            safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, 'Removing directory ' + task.path);
            api(backupConfig.provider).removeDir(backupConfig, backupFilePath, iteratorCallback);
        } else if (task.operation === 'mkdir') { // unused
            safe.fs.writeFileSync(paths.BACKUP_RESULT_FILE, 'Adding directory ' + task.path);
        }
    }, 10 /* concurrency */, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        callback();
    });
}

function saveEmptyDirs(appDataDir, callback) {
    assert.strictEqual(typeof appDataDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    var emptyDirs = safe.child_process.execSync('find . -type d -empty', { cwd: `${appDataDir}` });

    if (emptyDirs === null) return callback(safe.error);

    if (!safe.fs.writeFileSync(`${appDataDir}/emptydirs.txt`, emptyDirs)) return callback(safe.error);
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
            var tarStream = createTarPackStream(dataDir, backupConfig.key || null);
            tarStream.on('error', callback); // already returns BackupsError
            api(backupConfig.provider).upload(backupConfig, getBackupFilePath(backupConfig, backupId, format), tarStream, callback);
        } else {
            async.series([
                saveEmptyDirs.bind(null, dataDir),
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

function createEmptyDirs(appDataDir, callback) {
    assert.strictEqual(typeof appDataDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('createEmptyDirs: recreating empty directories');

    var emptyDirs = safe.fs.readFileSync(path.join(appDataDir, 'emptydirs.txt'), 'utf8');
    if (emptyDirs === null) return callback(new Error('emptydirs.txt was not found:' + safe.error.message));

    async.eachSeries(emptyDirs.trim().split('\n'), function createPath(emptyDir, iteratorDone) {
        mkdirp(path.join(appDataDir, emptyDir), iteratorDone);
    }, callback);
}

function download(backupId, format, dataDir, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof format, 'string');
    assert.strictEqual(typeof dataDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('download: id %s dataDir %s format %s', backupId, dataDir, format);

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        if (format === 'tgz') {
            api(backupConfig.provider).download(backupConfig, getBackupFilePath(backupConfig, backupId, format), function (error, sourceStream) {
                if (error) return callback(error);

                tarExtract(sourceStream, dataDir, backupConfig.key || null, callback);
            });
        } else {
            async.series([
                api(backupConfig.provider).downloadDir.bind(null, backupConfig, getBackupFilePath(backupConfig, backupId, format), dataDir),
                createEmptyDirs.bind(null, dataDir)
            ], callback);
        }
    });
}

function runBackupTask(backupId, format, dataDir, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof format, 'string');
    assert.strictEqual(typeof dataDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    var killTimerId = null, progressTimerId = null;

    var cp = shell.sudo(`backup-${backupId}`, [ BACKUPTASK_CMD, backupId, format, dataDir ], { env: process.env, logFile: paths.BACKUP_LOG_FILE }, function (error) {
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

    var password = config.database().password ? '-p' + config.database().password : '--skip-password';
    var mysqlDumpArgs = [
        '-c',
        `/usr/bin/mysqldump -u root ${password} --single-transaction --routines \
            --triggers ${config.database().name} > "${paths.BOX_DATA_DIR}/box.mysqldump"`
    ];
    shell.exec('backupBox', '/bin/bash', mysqlDumpArgs, { }, function (error) {
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

        // for the moment, box backups are always tarball based. this is because it makes it easy to restore
        // in the future, if required, we can move out the mailboxes to a separate virtual app backup
        const format = 'tgz';

        runBackupTask('snapshot/box', format, paths.BOX_DATA_DIR, function (error) {
            if (error) return callback(error);

            debug('uploadBoxSnapshot: time: %s secs', (new Date() - startTime)/1000);

            setSnapshotInfo('box', { timestamp: new Date().toISOString(), format: format }, callback);
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
    const format = 'tgz';

    debug('rotateBoxBackup: rotating to id:%s', backupId);

    backupdb.add({ id: backupId, version: config.version(), type: backupdb.BACKUP_TYPE_BOX, dependsOn: appBackupIds, restoreConfig: null, format: format }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        progress.setDetail(progress.BACKUP, 'Rotating box snapshot');

        api(backupConfig.provider).copy(backupConfig, getBackupFilePath(backupConfig, 'snapshot/box', format), getBackupFilePath(backupConfig, backupId, format), function (copyBackupError) {
            const state = copyBackupError ? backupdb.BACKUP_STATE_ERROR : backupdb.BACKUP_STATE_NORMAL;

            backupdb.update(backupId, { state: state }, function (error) {
                if (copyBackupError) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, copyBackupError.message));
                if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

                debug('rotateBoxBackup: successful id:%s', backupId);

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

function snapshotApp(app, manifest, callback) {
    assert.strictEqual(typeof app, 'object');
    assert(manifest && typeof manifest === 'object');
    assert.strictEqual(typeof callback, 'function');

    var restoreConfig = apps.getAppConfig(app);
    restoreConfig.manifest = manifest;

    if (!safe.fs.writeFileSync(path.join(paths.APPS_DATA_DIR, app.id + '/config.json'), JSON.stringify(restoreConfig))) {
        return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, 'Error creating config.json: ' + safe.error.message));
    }

    addons.backupAddons(app, manifest.addons, function (error) {
        if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error.message));

        return callback(null, restoreConfig);
    });
}

function setRestorePoint(appId, lastBackupId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof lastBackupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    appdb.update(appId, { lastBackupId: lastBackupId }, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new BackupsError(BackupsError.NOT_FOUND, 'No such app'));
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

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
    var restoreConfig = snapshotInfo.restoreConfig;
    var manifest = restoreConfig.manifest;
    var backupId = util.format('%s/app_%s_%s_v%s', timestamp, app.id, snapshotTime, manifest.version);
    const format = backupConfig.format;

    debugApp(app, 'rotateAppBackup: rotating to id:%s', backupId);

    backupdb.add({ id: backupId, version: manifest.version, type: backupdb.BACKUP_TYPE_APP, dependsOn: [ ], restoreConfig: restoreConfig, format: format }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        progress.setDetail(progress.BACKUP, 'Rotating app snapshot');

        api(backupConfig.provider).copy(backupConfig, getBackupFilePath(backupConfig, `snapshot/app_${app.id}`, format), getBackupFilePath(backupConfig, backupId, format), function (copyBackupError) {
            const state = copyBackupError ? backupdb.BACKUP_STATE_ERROR : backupdb.BACKUP_STATE_NORMAL;
            debugApp(app, 'rotateAppBackup: successful id:%s', backupId);

            backupdb.update(backupId, { state: state }, function (error) {
                if (copyBackupError) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, copyBackupError.message));
                if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

                setRestorePoint(app.id, backupId, function (error) {
                    if (error) return callback(error);

                    return callback(null, backupId);
                });
            });
        });
    });
}

function uploadAppSnapshot(backupConfig, app, manifest, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof app, 'object');
    assert(manifest && typeof manifest === 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!canBackupApp(app)) return callback(); // nothing to do

    var startTime = new Date();

    snapshotApp(app, manifest, function (error, restoreConfig) {
        if (error) return callback(error);

        var backupId = util.format('snapshot/app_%s', app.id);
        var appDataDir = safe.fs.realpathSync(path.join(paths.APPS_DATA_DIR, app.id));
        runBackupTask(backupId, backupConfig.format, appDataDir, function (error) {
            if (error) return callback(error);

            debugApp(app, 'uploadAppSnapshot: %s done time: %s secs', backupId, (new Date() - startTime)/1000);

            setSnapshotInfo(app.id, { timestamp: new Date().toISOString(), restoreConfig: restoreConfig, format: backupConfig.format }, callback);
        });
    });
}

function backupAppWithTimestamp(app, manifest, timestamp, callback) {
    assert.strictEqual(typeof app, 'object');
    assert(manifest && typeof manifest === 'object');
    assert.strictEqual(typeof timestamp, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!canBackupApp(app)) return callback(); // nothing to do

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        uploadAppSnapshot(backupConfig, app, manifest, function (error) {
            if (error) return callback(error);

            rotateAppBackup(backupConfig, app, timestamp, callback);
        });
    });
}

function backupApp(app, manifest, callback) {
    assert.strictEqual(typeof app, 'object');
    assert(manifest && typeof manifest === 'object');
    assert.strictEqual(typeof callback, 'function');

    const timestamp = (new Date()).toISOString().replace(/[T.]/g, '-').replace(/[:Z]/g,'');

    progress.set(progress.BACKUP, 10,  'Backing up ' + (app.altDomain || config.appFqdn(app.location)));

    backupAppWithTimestamp(app, manifest, timestamp, function (error) {
        progress.set(progress.BACKUP, 100, error ? error.message : '');

        callback(error);
    });
}

// this function expects you to have a lock
function backupBoxAndApps(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');

    callback = callback || NOOP_CALLBACK;

    var timestamp = (new Date()).toISOString().replace(/[T.]/g, '-').replace(/[:Z]/g,'');

    eventlog.add(eventlog.ACTION_BACKUP_START, auditSource, { });

    apps.getAll(function (error, allApps) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var processed = 0;
        var step = 100/(allApps.length+1);

        progress.set(progress.BACKUP, Math.min(step * processed, 5), '');

        async.mapSeries(allApps, function iterator(app, iteratorCallback) {
            progress.set(progress.BACKUP, step * processed,  'Backing up ' + (app.altDomain || config.appFqdn(app.location)));

            ++processed;

            if (!app.enableBackup) {
                progress.set(progress.BACKUP, step * processed, 'Skipped backup ' + (app.altDomain || config.appFqdn(app.location)));
                return iteratorCallback(null, app.lastBackupId); // just use the last backup
            }

            backupAppWithTimestamp(app, app.manifest, timestamp, function (error, backupId) {
                if (error && error.reason !== BackupsError.BAD_STATE) {
                    debugApp(app, 'Unable to backup', error);
                    return iteratorCallback(error);
                }

                progress.set(progress.BACKUP, step * processed, 'Backed up ' + (app.altDomain || config.appFqdn(app.location)));

                iteratorCallback(null, backupId || null); // clear backupId if is in BAD_STATE and never backed up
            });
        }, function appsBackedUp(error, backupIds) {
            if (error) {
                progress.set(progress.BACKUP, 100, error.message);
                return callback(error);
            }

            backupIds = backupIds.filter(function (id) { return id !== null; }); // remove apps in bad state that were never backed up

            progress.set(progress.BACKUP, step * processed, 'Backing up system data');

            backupBoxWithAppBackupIds(backupIds, timestamp, function (error, filename) {
                progress.set(progress.BACKUP, 100, error ? error.message : '');

                eventlog.add(eventlog.ACTION_BACKUP_FINISH, auditSource, { errorMessage: error ? error.message : null, filename: filename });

                callback(error, filename);
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

function restoreApp(app, addonsToRestore, backupId, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof addonsToRestore, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');
    assert(app.lastBackupId);

    var appDataDir = safe.fs.realpathSync(path.join(paths.APPS_DATA_DIR, app.id));

    var startTime = new Date();

    backupdb.get(backupId, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new BackupsError(BackupsError.NOT_FOUND, error));
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        async.series([
            download.bind(null, backupId, result.format, appDataDir),
            addons.restoreAddons.bind(null, app, addonsToRestore)
        ], function (error) {
            debug('restoreApp: time: %s', (new Date() - startTime)/1000);

            callback(error);
        });
    });
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

            var removeFunc = backup.format ==='tgz' ? api(backupConfig.provider).remove : api(backupConfig.provider).removeDir;
            var backupFilePath = getBackupFilePath(backupConfig, backup.id, backup.format);

            removeFunc(backupConfig, backupFilePath, function (error) {
                if (error) {
                    debug('cleanupAppBackups: error removing backup %j : %s', backup, error.message);
                    iteratorDone();
                }

                // prune empty directory
                api(backupConfig.provider).remove(backupConfig, path.dirname(backupFilePath), function (error) {
                    if (error) debug('cleanupAppBackups: unable to remove backup directory %j : %s', backup, error.message);

                    backupdb.del(backup.id, function (error) {
                        if (error) debug('cleanupAppBackups: error removing from database', error);
                        else debug('cleanupAppBackups: removed %s', backup.id);

                        iteratorDone();
                    });
                });
            });
        }, function () {
            debug('cleanupAppBackups: done');

            callback();
        });
    });
}

function cleanupBoxBackups(backupConfig, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
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
            debug('cleanupBoxBackups: preserving box backup %j', boxBackups[i]);
            referencedAppBackups = boxBackups[i].dependsOn;
            boxBackups.splice(i, 1);
        } else {
            debug('cleanupBoxBackups: no box backup to preserve');
        }

        async.eachSeries(boxBackups, function iterator(backup, iteratorDone) {
            referencedAppBackups = referencedAppBackups.concat(backup.dependsOn);

            // TODO: errored backups should probably be cleaned up before retention time, but we will
            // have to be careful not to remove any backup currently being created
            if ((now - backup.creationTime) < (backupConfig.retentionSecs * 1000)) return iteratorDone();

            debug('cleanupBoxBackups: removing %s', backup.id);

            // TODO: assumes all backups have the same format
            var filePaths = [].concat(backup.id, backup.dependsOn).map(function (id) { return getBackupFilePath(backupConfig, id, backup.format); });

            async.eachSeries(filePaths, function (filePath, next) {
                var removeFunc = backup.format ==='tgz' ? api(backupConfig.provider).remove : api(backupConfig.provider).removeDir;

                async.series([
                    removeFunc.bind(null, backupConfig, filePath),
                    api(backupConfig.provider).remove.bind(null, backupConfig, path.dirname(filePath))
                ], next);
            }, function (error) {
                if (error) {
                    debug('cleanupBoxBackups: error removing backup %j : %s', backup, error.message);
                    iteratorDone();
                }

                backupdb.del(backup.id, function (error) {
                    if (error) debug('cleanupBoxBackups: error removing from database', error);
                    else debug('cleanupBoxBackups: removed %j', filePaths);

                    iteratorDone();
                });
            });
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

            var removeFunc = info[appId].format ==='tgz' ? api(backupConfig.provider).remove : api(backupConfig.provider).removeDir;
            removeFunc(backupConfig, getBackupFilePath(backupConfig, `snapshot/app_${appId}`, info[appId].format), function (/* ignoredError */) {
                setSnapshotInfo(appId, null);

                safe.fs.unlinkSync(path.join(paths.BACKUP_INFO_DIR, `${appId}.sync.cache`));
                safe.fs.unlinkSync(path.join(paths.BACKUP_INFO_DIR, `${appId}.sync.cache.new`));

                iteratorDone();
            });
        });
    }, callback);
}

function cleanup(callback) {
    assert(!callback || typeof callback === 'function'); // callback is null when called from cronjob

    callback = callback || NOOP_CALLBACK;

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(error);

        if (backupConfig.retentionSecs < 0) {
            debug('cleanup: keeping all backups');
            return callback();
        }

        cleanupBoxBackups(backupConfig, function (error, referencedAppBackups) {
            if (error) return callback(error);

            cleanupAppBackups(backupConfig, referencedAppBackups, function (error) {
                if (error) return callback(error);

                cleanupSnapshots(backupConfig, callback);
            });
        });
    });
}
