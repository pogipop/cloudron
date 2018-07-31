'use strict';

exports = module.exports = {
    updateToLatest: updateToLatest,

    UpdaterError: UpdaterError
};

var assert = require('assert'),
    backups = require('./backups.js'),
    caas = require('./caas.js'),
    config = require('./config.js'),
    debug = require('debug')('box:updater'),
    eventlog = require('./eventlog.js'),
    locker = require('./locker.js'),
    path = require('path'),
    progress = require('./progress.js'),
    shell = require('./shell.js'),
    updateChecker = require('./updatechecker.js'),
    util = require('util'),
    _ = require('underscore');

const UPDATE_CMD = path.join(__dirname, 'scripts/update.sh');

function UpdaterError(reason, errorOrMessage) {
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
util.inherits(UpdaterError, Error);
UpdaterError.INTERNAL_ERROR = 'Internal Error';
UpdaterError.EXTERNAL_ERROR = 'External Error';
UpdaterError.BAD_STATE = 'Bad state';
UpdaterError.ALREADY_UPTODATE = 'No Update Available';
UpdaterError.NOT_FOUND = 'Not found';
UpdaterError.SELF_UPGRADE_NOT_SUPPORTED = 'Self upgrade not supported';

function update(boxUpdateInfo, auditSource, callback) {
    assert.strictEqual(typeof boxUpdateInfo, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!boxUpdateInfo) return callback(null);

    var error = locker.lock(locker.OP_BOX_UPDATE);
    if (error) return callback(new UpdaterError(UpdaterError.BAD_STATE, error.message));

    eventlog.add(eventlog.ACTION_UPDATE, auditSource, { boxUpdateInfo: boxUpdateInfo });

    // ensure tools can 'wait' on progress
    progress.set(progress.UPDATE, 0, 'Starting');

    // initiate the update/upgrade but do not wait for it
    if (boxUpdateInfo.upgrade) {
        debug('Starting upgrade');
        caas.upgrade(boxUpdateInfo, function (error) {
            if (error) {
                debug('Upgrade failed with error:', error);
                locker.unlock(locker.OP_BOX_UPDATE);
            }
        });
    } else {
        debug('Starting update');
        doUpdate(boxUpdateInfo, function (error) {
            if (error) {
                debug('Update failed with error:', error);
                locker.unlock(locker.OP_BOX_UPDATE);
            }
        });
    }

    callback(null);
}

function updateToLatest(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    var boxUpdateInfo = updateChecker.getUpdateInfo().box;
    if (!boxUpdateInfo) return callback(new UpdaterError(UpdaterError.ALREADY_UPTODATE, 'No update available'));
    if (!boxUpdateInfo.sourceTarballUrl) return callback(new UpdaterError(UpdaterError.BAD_STATE, 'No automatic update available'));

    if (boxUpdateInfo.upgrade && config.provider() !== 'caas') return callback(new UpdaterError(UpdaterError.SELF_UPGRADE_NOT_SUPPORTED));

    update(boxUpdateInfo, auditSource, callback);
}

function doUpdate(boxUpdateInfo, callback) {
    assert(boxUpdateInfo && typeof boxUpdateInfo === 'object');

    function updateError(e) {
        progress.set(progress.UPDATE, -1, e.message);
        callback(e);
    }

    progress.set(progress.UPDATE, 5, 'Backing up for update');

    backups.backupBoxAndApps({ userId: null, username: 'updater' }, function (error) {
        if (error) return updateError(error);

        // NOTE: this data is opaque and will be passed through the installer.sh
        var data= {
            provider: config.provider(),
            apiServerOrigin: config.apiServerOrigin(),
            webServerOrigin: config.webServerOrigin(),
            adminDomain: config.adminDomain(),
            adminFqdn: config.adminFqdn(),
            adminLocation: config.adminLocation(),
            isDemo: config.isDemo(),

            appstore: {
                apiServerOrigin: config.apiServerOrigin()
            },
            caas: {
                apiServerOrigin: config.apiServerOrigin(),
                webServerOrigin: config.webServerOrigin()
            },

            version: boxUpdateInfo.version
        };

        debug('updating box %s %j', boxUpdateInfo.sourceTarballUrl, _.omit(data, 'tlsCert', 'tlsKey', 'token', 'appstore', 'caas'));

        progress.set(progress.UPDATE, 5, 'Downloading and installing new version');

        shell.sudo('update', [ UPDATE_CMD, boxUpdateInfo.sourceTarballUrl, JSON.stringify(data) ], function (error) {
            if (error) return updateError(error);

            // Do not add any code here. The installer script will stop the box code any instant
        });
    });
}
