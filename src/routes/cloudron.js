'use strict';

exports = module.exports = {
    reboot: reboot,
    getProgress: getProgress,
    getConfig: getConfig,
    getDisks: getDisks,
    getUpdateInfo: getUpdateInfo,
    update: update,
    feedback: feedback,
    checkForUpdates: checkForUpdates,
    getLogs: getLogs,
    getLogStream: getLogStream
};

var appstore = require('../appstore.js'),
    AppstoreError = require('../appstore.js').AppstoreError,
    assert = require('assert'),
    async = require('async'),
    cloudron = require('../cloudron.js'),
    CloudronError = cloudron.CloudronError,
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    progress = require('../progress.js'),
    updateChecker = require('../updatechecker.js'),
    _ = require('underscore');

function auditSource(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
}

function getProgress(req, res, next) {
    return next(new HttpSuccess(200, progress.getAll()));
}

function reboot(req, res, next) {
    // Finish the request, to let the appstore know we triggered the restore it
    next(new HttpSuccess(202, {}));

    cloudron.reboot(function () { });
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
    cloudron.updateToLatest(auditSource(req), function (error) {
        if (error && error.reason === CloudronError.ALREADY_UPTODATE) return next(new HttpError(422, error.message));
        if (error && error.reason === CloudronError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error && error.reason === CloudronError.SELF_UPGRADE_NOT_SUPPORTED) return next(new HttpError(412, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}

function getUpdateInfo(req, res, next) {
    next(new HttpSuccess(200, { update: updateChecker.getUpdateInfo() }));
}

function checkForUpdates(req, res, next) {
    async.series([
        updateChecker.checkAppUpdates,
        updateChecker.checkBoxUpdates
    ], function () {
        next(new HttpSuccess(200, { update: updateChecker.getUpdateInfo() }));
    });
}

function feedback(req, res, next) {
    assert.strictEqual(typeof req.user, 'object');

    const VALID_TYPES = [ 'feedback', 'ticket', 'app_missing', 'app_error', 'upgrade_request' ];

    if (typeof req.body.type !== 'string' || !req.body.type) return next(new HttpError(400, 'type must be string'));
    if (VALID_TYPES.indexOf(req.body.type) === -1) return next(new HttpError(400, 'unknown type'));
    if (typeof req.body.subject !== 'string' || !req.body.subject) return next(new HttpError(400, 'subject must be string'));
    if (typeof req.body.description !== 'string' || !req.body.description) return next(new HttpError(400, 'description must be string'));
    if (req.body.appId && typeof req.body.appId !== 'string') return next(new HttpError(400, 'appId must be string'));

    appstore.sendFeedback(_.extend(req.body, { email: req.user.email, displayName: req.user.displayName }), function (error) {
        if (error && error.reason === AppstoreError.BILLING_REQUIRED) return next(new HttpError(402, 'Login to App Store to create support tickets. You can also email support@cloudron.io'));
        if (error) return next(new HttpError(503, 'Error contacting cloudron.io. Please email support@cloudron.io'));

        next(new HttpSuccess(201, {}));
    });

}

function getLogs(req, res, next) {
    assert.strictEqual(typeof req.params.unit, 'string');

    var lines = req.query.lines ? parseInt(req.query.lines, 10) : 100;
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a number'));

    var options = {
        lines: lines,
        follow: false,
        format: req.query.format
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

    var lines = req.query.lines ? parseInt(req.query.lines, 10) : -10; // we ignore last-event-id
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a valid number'));

    function sse(id, data) { return 'id: ' + id + '\ndata: ' + data + '\n\n'; }

    if (req.headers.accept !== 'text/event-stream') return next(new HttpError(400, 'This API call requires EventStream'));

    var options = {
        lines: lines,
        follow: true,
        format: req.query.format
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
