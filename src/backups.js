'use strict';

exports = module.exports = {
    BackupsError: BackupsError,

    testConfig: testConfig,

    getPaged: getPaged,
    getByAppIdPaged: getByAppIdPaged,

    getDownloadStream: getDownloadStream,

    getRestoreConfig: getRestoreConfig,

    ensureBackup: ensureBackup,

    backup: backup,
    backupApp: backupApp,
    restoreApp: restoreApp,

    backupBoxAndApps: backupBoxAndApps,

    removeBackup: removeBackup
};

var addons = require('./addons.js'),
    appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    async = require('async'),
    assert = require('assert'),
    backupdb = require('./backupdb.js'),
    caas = require('./storage/caas.js'),
    config = require('./config.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:backups'),
    eventlog = require('./eventlog.js'),
    filesystem = require('./storage/filesystem.js'),
    locker = require('./locker.js'),
    mailer = require('./mailer.js'),
    path = require('path'),
    paths = require('./paths.js'),
    progress = require('./progress.js'),
    s3 = require('./storage/s3.js'),
    shell = require('./shell.js'),
    settings = require('./settings.js'),
    SettingsError = require('./settings.js').SettingsError,
    util = require('util');

var BACKUPTASK_CMD = path.join(__dirname, 'backuptask.js');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

function debugApp(app, args) {
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
BackupsError.NOT_FOUND = 'not found';
BackupsError.MISSING_CREDENTIALS = 'missing credentials';

// choose which storage backend we use for test purpose we use s3
function api(provider) {
    switch (provider) {
        case 'caas': return caas;
        case 's3': return s3;
        case 'filesystem': return filesystem;
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

function getPaged(page, perPage, callback) {
    assert(typeof page === 'number' && page > 0);
    assert(typeof perPage === 'number' && perPage > 0);
    assert.strictEqual(typeof callback, 'function');

    backupdb.getPaged(page, perPage, function (error, results) {
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

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        api(backupConfig.provider).getAppRestoreConfig(backupConfig, backupId, function (error, result) {
            if (error && error.reason === BackupsError.NOT_FOUND) return callback(error);
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));

            callback(null, result);
        });
    });
}

function copyLastBackup(app, manifest, prefix, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof app.lastBackupId, 'string');
    assert(manifest && typeof manifest === 'object');
    assert.strictEqual(typeof prefix, 'string');
    assert.strictEqual(typeof callback, 'function');

    var timestamp = (new Date()).toISOString().replace(/[T.]/g, '-').replace(/[:Z]/g,'');
    var newBackupId = util.format('%s/app_%s_%s_v%s', prefix, app.id, timestamp, manifest.version);

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        debug('copyLastBackup: copying backup %s to %s', app.lastBackupId, newBackupId);

        api(backupConfig.provider).copyAppRestoreConfig(backupConfig, app.lastBackupId, newBackupId, function (error) {
            if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));

            api(backupConfig.provider).copyBackup(backupConfig, app.lastBackupId, newBackupId, function (error) {
                if (error) return callback(new BackupsError(BackupsError.EXTERNAL_ERROR, error));

                callback(null, newBackupId);
            });
        });
    });
}

function backupBoxWithAppBackupIds(appBackupIds, prefix, callback) {
    assert(util.isArray(appBackupIds));
    assert.strictEqual(typeof prefix, 'string');

    var timestamp = (new Date()).toISOString().replace(/[T.]/g, '-').replace(/[:Z]/g,'');
    var backupId = util.format('%s/box_%s_v%s', prefix, timestamp, config.version());

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var mysqlDumpArgs = ['-c', '/usr/bin/mysqldump -u root -ppassword --single-transaction --routines --triggers box > "' + paths.BOX_DATA_DIR + '/box.mysqldump"' ];
        shell.exec('backupBox', '/bin/bash', mysqlDumpArgs, function (error) {
            if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

            shell.sudo('backupBox', [ BACKUPTASK_CMD, backupId ], function (error) {
                if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

                debug('backupBoxWithAppBackupIds: success');

                backupdb.add({ id: backupId, version: config.version(), type: backupdb.BACKUP_TYPE_BOX, dependsOn: appBackupIds, restoreConfig: null }, function (error) {
                    if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

                    // FIXME this is only needed for caas, is it really???
                    api(backupConfig.provider).backupDone(backupId, null /* app */, appBackupIds, function (error) {
                        if (error) return callback(error);
                        callback(null, backupId);
                    });
                });
            });
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

function createNewAppBackup(app, manifest, prefix, callback) {
    assert.strictEqual(typeof app, 'object');
    assert(manifest && typeof manifest === 'object');
    assert.strictEqual(typeof prefix, 'string');
    assert.strictEqual(typeof callback, 'function');

    var timestamp = (new Date()).toISOString().replace(/[T.]/g, '-').replace(/[:Z]/g,'');
    var backupId = util.format('%s/app_%s_%s_v%s', prefix, app.id, timestamp, config.version());

    // FIXME move addon backup into backuptask
    async.series([
        addons.backupAddons.bind(null, app, manifest.addons),
        shell.sudo.bind(null, 'backupApp', [ BACKUPTASK_CMD, backupId, app.id ])
    ], function (error) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        debugApp(app, 'createNewAppBackup: %s done', backupId);

        var restoreConfig = apps.getAppConfig(app);
        restoreConfig.manifest = manifest;

        backupdb.add({ id: backupId, version: manifest.version, type: backupdb.BACKUP_TYPE_APP, dependsOn: [ ], restoreConfig: restoreConfig }, function (error) {
            if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

            callback(null, backupId);
        });
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

function backupApp(app, manifest, prefix, callback) {
    assert.strictEqual(typeof app, 'object');
    assert(manifest && typeof manifest === 'object');
    assert.strictEqual(typeof prefix, 'string');
    assert.strictEqual(typeof callback, 'function');

    var backupFunction;

    if (!canBackupApp(app)) {
        if (!app.lastBackupId) {
            debugApp(app, 'backupApp: cannot backup app');
            return callback(new BackupsError(BackupsError.BAD_STATE, 'App not healthy and never backed up previously'));
        }

        // set the 'creation' date of lastBackup so that the backup persists across time based archival rules
        // s3 does not allow changing creation time, so copying the last backup is easy way out for now
        backupFunction = copyLastBackup.bind(null, app, manifest, prefix);
    } else {
        backupFunction = createNewAppBackup.bind(null, app, manifest, prefix);
    }

    backupFunction(function (error, backupId) {
        if (error) return callback(error);

        debugApp(app, 'backupApp: successful id:%s', backupId);

        setRestorePoint(app.id, backupId, function (error) {
            if (error) return callback(error);

            return callback(null, backupId);
        });
    });
}

// this function expects you to have a lock
function backupBoxAndApps(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');

    callback = callback || NOOP_CALLBACK;

    var prefix = (new Date()).toISOString().replace(/[T.]/g, '-').replace(/[:Z]/g,'');

    eventlog.add(eventlog.ACTION_BACKUP_START, auditSource, { });

    apps.getAll(function (error, allApps) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        var processed = 0;
        var step = 100/(allApps.length+1);

        progress.set(progress.BACKUP, step * processed, '');

        async.mapSeries(allApps, function iterator(app, iteratorCallback) {
            progress.set(progress.BACKUP, step * processed,  'Backing up ' + (app.altDomain || config.appFqdn(app.location)));

            ++processed;

            backupApp(app, app.manifest, prefix, function (error, backupId) {
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

            backupBoxWithAppBackupIds(backupIds, prefix, function (error, filename) {
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

    progress.set(progress.BACKUP, 0, 'Starting'); // ensure tools can 'wait' on progress

    backupBoxAndApps(auditSource, function (error) { // start the backup operation in the background
        if (error) {
            debug('backup failed.', error);
            mailer.backupFailed(error);
        }

        locker.unlock(locker.OP_FULL_BACKUP);
    });

    callback(null);
}

function ensureBackup(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');

    debug('ensureBackup: %j', auditSource);

    getPaged(1, 1, function (error, backups) {
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

        var directoryMapping = [{
            source: '/',
            destination: path.join(paths.APPS_DATA_DIR, app.id)
        }];

        async.series([
            api(backupConfig.provider).restore.bind(null, backupConfig, backupId, directoryMapping),
            addons.restoreAddons.bind(null, app, addonsToRestore)
        ], callback);
    });
}

function getDownloadStream(backupId, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        api(backupConfig.provider).getDownloadStream(backupConfig, backupId, function (error, result) {
            if (error) return callback(error);

            debug('getDownloadStream: %s', backupId);

            callback(null, result);
        });
    });
}

function removeBackup(backupId, appBackupIds, callback) {
    assert.strictEqual(typeof backupId, 'string');
    assert(util.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    debug('removeBackup: %s', backupId);

    settings.getBackupConfig(function (error, backupConfig) {
        if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

        api(backupConfig.provider).removeBackup(backupConfig, backupId, appBackupIds, function (error) {
            if (error) return callback(error);

            api(backupConfig.provider).removeAppRestoreConfig(backupConfig, backupId, appBackupIds, function (error) {
                if (error) return callback(error);

                backupdb.del(backupId, function (error) {
                    if (error) return callback(new BackupsError(BackupsError.INTERNAL_ERROR, error));

                    debug('removeBackup: %s done', backupId);

                    callback(null);
                });
            });
        });
    });
}
