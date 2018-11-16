'use strict';

exports = module.exports = {
    get: get,
    create: create
};

var backupdb = require('../backupdb.js'),
    backups = require('../backups.js'),
    BackupsError = require('../backups.js').BackupsError,
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function auditSource(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
}

function get(req, res, next) {
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

function create(req, res, next) {
    // note that cloudron.backup only waits for backup initiation and not for backup to complete
    // backup progress can be checked up ny polling the progress api call
    backups.runBackupTask(auditSource(req), function (error) {
        if (error && error.reason === BackupsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}
