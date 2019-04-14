'use strict';

exports = module.exports = {
    list: list,
    startBackup: startBackup,
    cleanup: cleanup
};

let auditSource = require('../auditsource.js'),
    backupdb = require('../backupdb.js'),
    backups = require('../backups.js'),
    BackupsError = require('../backups.js').BackupsError,
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function list(req, res, next) {
    var page = typeof req.query.page !== 'undefined' ? parseInt(req.query.page) : 1;
    if (!page || page < 0) return next(new HttpError(400, 'page query param has to be a postive number'));

    var perPage = typeof req.query.per_page !== 'undefined'? parseInt(req.query.per_page) : 25;
    if (!perPage || perPage < 0) return next(new HttpError(400, 'per_page query param has to be a postive number'));

    backups.getByStatePaged(backupdb.BACKUP_STATE_NORMAL, page, perPage, function (error, result) {
        if (error && error.reason === BackupsError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { backups: result }));
    });
}

function startBackup(req, res, next) {
    backups.startBackupTask(auditSource.fromRequest(req), function (error, taskId) {
        if (error && error.reason === BackupsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { taskId }));
    });
}

function cleanup(req, res, next) {
    backups.startCleanupTask(auditSource.fromRequest(req), function (error, taskId) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { taskId }));
    });
}
