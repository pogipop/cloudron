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

    cleanup: cleanup
};

var addons = require('./addons.js'),
    appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    AppsError = require('./apps.js').AppsError,
    async = require('async'),
    assert = require('assert'),
    backupdb = require('./backupdb.js'),
    config = require('./config.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:backups'),
    eventlog = require('./eventlog.js'),
    locker = require('./locker.js'),
    mailer = require('./mailer.js'),
    path = require('path'),
    paths = require('./paths.js'),
    progress = require('./progress.js'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    settings = require('./settings.js'),
    SettingsError = require('./settings.js').SettingsError,
    util = require('util');

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
    case 'caas': return require('./storage/caas.js');
    case 's3': return require('./storage/s3.js');
    case 'filesystem': return require('./storage/filesystem.js');
    case 'minio': return require('./storage/s3.js');
    case 'exoscale-sos': return require('./storage/s3.js');
    case 'noop': return require('./storage/noop.js');
    default: return null;
    }
}

function testConfig(backupConfig, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    var func = api(backupConfig.provider);
    if (!func) return callback(new SettingsError(SettingsError.BAD_FIELD, 'unkown storage provider'));

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

function getBackupFilePath(backupConfig, backupId) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');

    const FILE_TYPE = backupConfig.key ? '.tar.gz.enc' : '.tar.gz';

    return path.join(backupConfig.prefix || backupConfig.backupFolder, backupId+FILE_TYPE);
}

// this function is called via backuptask (since it needs root to traverse app's directory)
function upload(backupId, dataDir, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('Start box backup with id %s', backupId);

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        api(backupConfig.provider).upload(backupConfig, getBackupFilePath(backupConfig, backupId), dataDir, callback);
    });
}

function runBackupTask(backupId, dataDir, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof dataDir, 'string');
    assert.strictEqual(typeof callback, 'function');

    var killTimerId = null;

    var cp = shell.sudo(`backup-${backupId}`, [ BACKUPTASK_CMD, backupId, dataDir ], function (error) {
        clearTimeout(killTimerId);
        cp = null;

        if (error && (error.code === null /* signal */ || (error.code !== 0 && error.code !== 50))) { // backuptask crashed
            return callback(new BackupsError(BackupsError.INTERNAL_ERROR, 'backuptask crashed'));
        } else if (error && error.code === 50) { // exited with error
            var result = safe.fs.readFileSync(paths.BACKUP_RESULT_FILE, 'utf8') || safe.error.message;
            return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, result));
        }

        callback();
    });

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

        runBackupTask('snapshot/box', paths.BOX_DATA_DIR, function (error) {
            if (error) return callback(error);

            debug('uploadBoxSnapshot: time: %s secs', (new Date() - startTime)/1000);

            setSnapshotInfo('box', { timestamp: new Date().toISOString() }, callback);
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

    backupdb.add({ id: backupId, version: config.version(), type: backupdb.BACKUP_TYPE_BOX, dependsOn: appBackupIds, restoreConfig: null }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        api(backupConfig.provider).copy(backupConfig, getBackupFilePath(backupConfig, 'snapshot/box'), getBackupFilePath(backupConfig, backupId), function (copyBackupError) {
            const state = copyBackupError ? backupdb.BACKUP_STATE_ERROR : backupdb.BACKUP_STATE_NORMAL;
            debug('rotateBoxBackup: successful id:%s', backupId);

            backupdb.update(backupId, { state: state }, function (error) {
                if (copyBackupError) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, copyBackupError.message));
                if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

                // FIXME this is only needed for caas, hopefully we can remove that in the future
                api(backupConfig.provider).backupDone(backupId, appBackupIds, function (error) {
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

    backupdb.add({ id: backupId, version: manifest.version, type: backupdb.BACKUP_TYPE_APP, dependsOn: [ ], restoreConfig: restoreConfig }, function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        api(backupConfig.provider).copy(backupConfig, getBackupFilePath(backupConfig, `snapshot/app_${app.id}`), getBackupFilePath(backupConfig, backupId), function (copyBackupError) {
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
        runBackupTask(backupId, appDataDir, function (error) {
            if (error) return callback(error);

            debugApp(app, 'uploadAppSnapshot: %s done time: %s secs', backupId, (new Date() - startTime)/1000);

            setSnapshotInfo(app.id, { timestamp: new Date().toISOString(), restoreConfig: restoreConfig }, callback);
        });
    });
}

function backupApp(app, manifest, timestamp, callback) {
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

        progress.set(progress.BACKUP, step * processed, '');

        async.mapSeries(allApps, function iterator(app, iteratorCallback) {
            progress.set(progress.BACKUP, step * processed,  'Backing up ' + (app.altDomain || config.appFqdn(app.location)));

            ++processed;

            if (!app.enableBackup) {
                progress.set(progress.BACKUP, step * processed, 'Skipped backup ' + (app.altDomain || config.appFqdn(app.location)));
                return iteratorCallback(null, app.lastBackupId); // just use the last backup
            }

            backupApp(app, app.manifest, timestamp, function (error, backupId) {
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

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var appDataDir = safe.fs.realpathSync(path.join(paths.APPS_DATA_DIR, app.id));

        var startTime = new Date();

        async.series([
            api(backupConfig.provider).download.bind(null, backupConfig, getBackupFilePath(backupConfig, backupId), appDataDir),
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

            debug('cleanup: removing %s', backup.id);

            api(backupConfig.provider).removeMany(backupConfig, [ getBackupFilePath(backupConfig, backup.id) ], function (error) {
                if (error) {
                    debug('cleanup: error removing backup %j : %s', backup, error.message);
                    iteratorDone();
                }

                backupdb.del(backup.id, function (error) {
                    if (error) debug('cleanup: error removing from database', error);
                    else debug('cleanup: removed %s', backup.id);

                    iteratorDone();
                });
            });
        }, function () {
            debug('cleanup: done cleaning app backups');

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
            debug('cleanup: preserving box backup %j', boxBackups[i]);
            referencedAppBackups = boxBackups[i].dependsOn;
            boxBackups.splice(i, 1);
        } else {
            debug('cleanup: no box backup to preserve');
        }

        async.eachSeries(boxBackups, function iterator(backup, iteratorDone) {
            referencedAppBackups = referencedAppBackups.concat(backup.dependsOn);

            // TODO: errored backups should probably be cleaned up before retention time, but we will
            // have to be careful not to remove any backup currently being created
            if ((now - backup.creationTime) < (backupConfig.retentionSecs * 1000)) return iteratorDone();

            debug('cleanup: removing %s', backup.id);

            var backupIds = [].concat(backup.id, backup.dependsOn);

            api(backupConfig.provider).removeMany(backupConfig, backupIds, function (error) {
                if (error) {
                    debug('cleanup: error removing backup %j : %s', backup, error.message);
                    iteratorDone();
                }

                backupdb.del(backup.id, function (error) {
                    if (error) debug('cleanup: error removing from database', error);
                    else debug('cleanup: removed %j', backupIds);

                    iteratorDone();
                });
            });
        }, function () {
            return callback(null, referencedAppBackups);
        });
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

            api(backupConfig.provider).removeMany(backupConfig, [ `snapshot/app_${appId}` ], function (/* ignoredError */) {
                setSnapshotInfo(appId, null);

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

            debug('cleanup: done cleaning box backups');

            cleanupAppBackups(backupConfig, referencedAppBackups, function (error) {
                if (error) return callback(error);

                debug('cleanup: done cleaning app backups');

                cleanupSnapshots(backupConfig, callback);
            });
        });
    });
}
