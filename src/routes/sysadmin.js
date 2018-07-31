'use strict';

exports = module.exports = {
    backup: backup,
    update: update,
    retire: retire
};

var backups = require('../backups.js'),
    BackupsError = require('../backups.js').BackupsError,
    cloudron = require('../cloudron.js'),
    debug = require('debug')('box:routes/sysadmin'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    updater = require('../updater.js'),
    UpdaterError = require('../updater.js').UpdaterError;

function backup(req, res, next) {
    debug('triggering backup');

    // note that cloudron.backup only waits for backup initiation and not for backup to complete
    // backup progress can be checked up ny polling the progress api call
    var auditSource = { userId: null, username: 'sysadmin' };
    backups.backup(auditSource, function (error) {
        if (error && error.reason === BackupsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}

function update(req, res, next) {
    debug('triggering update');

    // this only initiates the update, progress can be checked via the progress route
    var auditSource = { userId: null, username: 'sysadmin' };
    updater.updateToLatest(auditSource, function (error) {
        if (error && error.reason === UpdaterError.ALREADY_UPTODATE) return next(new HttpError(422, error.message));
        if (error && error.reason === UpdaterError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error && error.reason === UpdaterError.SELF_UPGRADE_NOT_SUPPORTED) return next(new HttpError(412, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}

function retire(req, res, next) {
    debug('triggering retire');

    cloudron.retire('migrate', { }, function (error) {
        if (error) console.error('Retire failed.', error);
    });

    next(new HttpSuccess(202, {}));
}
