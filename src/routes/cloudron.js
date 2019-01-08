'use strict';

exports = module.exports = {
    reboot: reboot,
    isRebootRequired: isRebootRequired,
    getConfig: getConfig,
    getDisks: getDisks,
    getUpdateInfo: getUpdateInfo,
    update: update,
    checkForUpdates: checkForUpdates,
    getLogs: getLogs,
    getLogStream: getLogStream,
    setDashboardDomain: setDashboardDomain,
    prepareDashboardDomain: prepareDashboardDomain,
    renewCerts: renewCerts
};

let assert = require('assert'),
    async = require('async'),
    cloudron = require('../cloudron.js'),
    CloudronError = cloudron.CloudronError,
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    updater = require('../updater.js'),
    updateChecker = require('../updatechecker.js'),
    UpdaterError = require('../updater.js').UpdaterError;

function auditSource(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
}

function reboot(req, res, next) {
    // Finish the request, to let the appstore know we triggered the reboot
    next(new HttpSuccess(202, {}));

    cloudron.reboot(function () {});
}

function isRebootRequired(req, res, next) {
    cloudron.isRebootRequired(function (error, result) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { rebootRequired: result }));
    });
}

function getConfig(req, res, next) {
    cloudron.getConfig(function (error, cloudronConfig) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, cloudronConfig));
    });
}

function getDisks(req, res, next) {
    cloudron.getDisks(function (error, result) {
        if (error) return next(new HttpError(500, error));
        next(new HttpSuccess(200, result));
    });
}

function update(req, res, next) {
    // this only initiates the update, progress can be checked via the progress route
    updater.updateToLatest(auditSource(req), function (error, taskId) {
        if (error && error.reason === UpdaterError.ALREADY_UPTODATE) return next(new HttpError(422, error.message));
        if (error && error.reason === UpdaterError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { taskId }));
    });
}

function getUpdateInfo(req, res, next) {
    next(new HttpSuccess(200, { update: updateChecker.getUpdateInfo() }));
}

function checkForUpdates(req, res, next) {
    // it can take a while sometimes to get all the app updates one by one
    req.clearTimeout();

    async.series([
        updateChecker.checkAppUpdates,
        updateChecker.checkBoxUpdates
    ], function () {
        next(new HttpSuccess(200, { update: updateChecker.getUpdateInfo() }));
    });
}

function getLogs(req, res, next) {
    assert.strictEqual(typeof req.params.unit, 'string');

    var lines = 'lines' in req.query ? parseInt(req.query.lines, 10) : 10; // we ignore last-event-id
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a number'));

    var options = {
        lines: lines,
        follow: false,
        format: req.query.format || 'json'
    };

    cloudron.getLogs(req.params.unit, options, function (error, logStream) {
        if (error && error.reason === CloudronError.BAD_FIELD) return next(new HttpError(404, 'Invalid type'));
        if (error) return next(new HttpError(500, error));

        res.writeHead(200, {
            'Content-Type': 'application/x-logs',
            'Content-Disposition': 'attachment; filename="log.txt"',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no' // disable nginx buffering
        });
        logStream.pipe(res);
    });
}

function getLogStream(req, res, next) {
    assert.strictEqual(typeof req.params.unit, 'string');

    var lines = 'lines' in req.query ? parseInt(req.query.lines, 10) : 10; // we ignore last-event-id
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a valid number'));

    function sse(id, data) { return 'id: ' + id + '\ndata: ' + data + '\n\n'; }

    if (req.headers.accept !== 'text/event-stream') return next(new HttpError(400, 'This API call requires EventStream'));

    var options = {
        lines: lines,
        follow: true,
        format: req.query.format || 'json'
    };

    cloudron.getLogs(req.params.unit, options, function (error, logStream) {
        if (error && error.reason === CloudronError.BAD_FIELD) return next(new HttpError(404, 'Invalid type'));
        if (error) return next(new HttpError(500, error));

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no', // disable nginx buffering
            'Access-Control-Allow-Origin': '*'
        });
        res.write('retry: 3000\n');
        res.on('close', logStream.close);
        logStream.on('data', function (data) {
            var obj = JSON.parse(data);
            res.write(sse(obj.monotonicTimestamp, JSON.stringify(obj))); // send timestamp as id
        });
        logStream.on('end', res.end.bind(res));
        logStream.on('error', res.end.bind(res, null));
    });
}

function setDashboardDomain(req, res, next) {
    if (!req.body.domain || typeof req.body.domain !== 'string') return next(new HttpError(400, 'domain must be a string'));

    cloudron.setDashboardDomain(req.body.domain, function (error) {
        if (error && error.reason === CloudronError.BAD_FIELD) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204, {}));
    });
}

function prepareDashboardDomain(req, res, next) {
    if (!req.body.domain || typeof req.body.domain !== 'string') return next(new HttpError(400, 'domain must be a string'));

    cloudron.prepareDashboardDomain(req.body.domain, auditSource(req), function (error, taskId) {
        if (error && error.reason === CloudronError.BAD_FIELD) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { taskId }));
    });
}

function renewCerts(req, res, next) {
    cloudron.renewCerts({ domain: req.body.domain || null }, auditSource(req), function (error, taskId) {
        if (error && error.reason === CloudronError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { taskId }));
    });
}
