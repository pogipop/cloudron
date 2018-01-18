'use strict';

exports = module.exports = {
    activate: activate,
    dnsSetup: dnsSetup,
    setupTokenAuth: setupTokenAuth,
    providerTokenAuth: providerTokenAuth,
    getStatus: getStatus,
    restore: restore,
    reboot: reboot,
    getProgress: getProgress,
    getConfig: getConfig,
    getDisks: getDisks,
    update: update,
    feedback: feedback,
    checkForUpdates: checkForUpdates,
    getLogs: getLogs,
    getLogStream: getLogStream,
    sendTestMail: sendTestMail
};

var appstore = require('../appstore.js'),
    AppstoreError = require('../appstore.js').AppstoreError,
    assert = require('assert'),
    async = require('async'),
    caas = require('../caas.js'),
    CaasError = require('../caas.js').CaasError,
    cloudron = require('../cloudron.js'),
    CloudronError = cloudron.CloudronError,
    config = require('../config.js'),
    debug = require('debug')('box:routes/cloudron'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    progress = require('../progress.js'),
    mailer = require('../mailer.js'),
    superagent = require('superagent'),
    updateChecker = require('../updatechecker.js'),
    _ = require('underscore');

function auditSource(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
}

function activate(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.username !== 'string') return next(new HttpError(400, 'username must be string'));
    if (typeof req.body.password !== 'string') return next(new HttpError(400, 'password must be string'));
    if (typeof req.body.email !== 'string') return next(new HttpError(400, 'email must be string'));
    if ('displayName' in req.body && typeof req.body.displayName !== 'string') return next(new HttpError(400, 'displayName must be string'));

    var username = req.body.username;
    var password = req.body.password;
    var email = req.body.email;
    var displayName = req.body.displayName || '';

    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    debug('activate: username:%s ip:%s', username, ip);

    cloudron.activate(username, password, email, displayName, ip, auditSource(req), function (error, info) {
        if (error && error.reason === CloudronError.ALREADY_PROVISIONED) return next(new HttpError(409, 'Already setup'));
        if (error && error.reason === CloudronError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        // only in caas case do we have to notify the api server about activation
        if (config.provider() !== 'caas') return next(new HttpSuccess(201, info));

        caas.setupDone(req.query.setupToken, function (error) {
            if (error && error.reason === CaasError.BAD_STATE) return next(new HttpError(409, 'Already setup'));
            if (error && error.reason === CaasError.INVALID_TOKEN) return next(new HttpError(403, 'Invalid token'));
            if (error && error.reason === CaasError.EXTERNAL_ERROR) return next(new HttpError(503, error.message));

            if (error) return next(new HttpError(500, error));

            next(new HttpSuccess(201, info));
        });
    });
}

function restore(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.backupConfig || typeof req.body.backupConfig !== 'object') return next(new HttpError(400, 'backupConfig is required'));

    var backupConfig = req.body.backupConfig;
    if (typeof backupConfig.provider !== 'string') return next(new HttpError(400, 'provider is required'));
    if ('key' in backupConfig && typeof backupConfig.key !== 'string') return next(new HttpError(400, 'key must be a string'));
    if (typeof backupConfig.format !== 'string') return next(new HttpError(400, 'format must be a string'));
    if ('acceptSelfSignedCerts' in backupConfig && typeof backupConfig.acceptSelfSignedCerts !== 'boolean') return next(new HttpError(400, 'format must be a boolean'));

    if (typeof req.body.backupId !== 'string') return next(new HttpError(400, 'backupId must be a string or null'));
    if (typeof req.body.version !== 'string') return next(new HttpError(400, 'version must be a string'));

    cloudron.restore(backupConfig, req.body.backupId, req.body.version, function (error) {
        if (error && error.reason === CloudronError.ALREADY_SETUP) return next(new HttpError(409, error.message));
        if (error && error.reason === CloudronError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === CloudronError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error && error.reason === CloudronError.EXTERNAL_ERROR) return next(new HttpError(402, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200));
    });
}

function dnsSetup(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.provider !== 'string' || !req.body.provider) return next(new HttpError(400, 'provider is required'));
    if (typeof req.body.domain !== 'string' || !req.body.domain) return next(new HttpError(400, 'domain is required'));
    if (typeof req.body.adminFqdn !== 'string' || !req.body.domain) return next(new HttpError(400, 'adminFqdn is required'));

    if ('zoneName' in req.body && typeof req.body.zoneName !== 'string') return next(new HttpError(400, 'zoneName must be a string'));
    if (!req.body.config || typeof req.body.config !== 'object') return next(new HttpError(400, 'config must be an object'));

    cloudron.dnsSetup(req.body.adminFqdn.toLowerCase(), req.body.domain.toLowerCase(), req.body.zoneName || '', req.body.provider, req.body.config, function (error) {
        if (error && error.reason === CloudronError.ALREADY_SETUP) return next(new HttpError(409, error.message));
        if (error && error.reason === CloudronError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200));
    });
}

function setupTokenAuth(req, res, next) {
    assert.strictEqual(typeof req.query, 'object');

    if (config.provider() !== 'caas') return next();

    if (typeof req.query.setupToken !== 'string' || !req.query.setupToken) return next(new HttpError(400, 'setupToken must be a non empty string'));

    caas.verifySetupToken(req.query.setupToken, function (error) {
        if (error && error.reason === CaasError.BAD_STATE) return next(new HttpError(409, 'Already setup'));
        if (error && error.reason === CaasError.INVALID_TOKEN) return next(new HttpError(403, 'Invalid token'));
        if (error && error.reason === CaasError.EXTERNAL_ERROR) return next(new HttpError(503, error.message));

        if (error) return next(new HttpError(500, error));

        next();
    });
}

function providerTokenAuth(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (config.provider() === 'ami') {
        if (typeof req.body.providerToken !== 'string' || !req.body.providerToken) return next(new HttpError(400, 'providerToken must be a non empty string'));

        superagent.get('http://169.254.169.254/latest/meta-data/instance-id').timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return next(new HttpError(500, error));
            if (result.statusCode !== 200) return next(new HttpError(500, 'Unable to get meta data'));

            if (result.text !== req.body.providerToken) return next(new HttpError(403, 'Invalid providerToken'));

            next();
        });
    } else {
        next();
    }
}

function getStatus(req, res, next) {
    cloudron.getStatus(function (error, status) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, status));
    });
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

        if (!req.user.admin) {
            cloudronConfig = _.pick(cloudronConfig, 'apiServerOrigin', 'webServerOrigin', 'fqdn', 'adminFqdn', 'version', 'progress', 'isDemo', 'cloudronName', 'provider');
        }

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

    appstore.sendFeedback(_.extend(req.body, { email: req.user.alternateEmail || req.user.email, displayName: req.user.displayName }), function (error) {
        if (error && error.reason === AppstoreError.BILLING_REQUIRED) return next(new HttpError(402, 'Login to App Store to create support tickets. You can also email support@cloudron.io'));
        if (error) return next(new HttpError(503, 'Error contacting cloudron.io. Please email support@cloudron.io'));

        next(new HttpSuccess(201, {}));
    });

}

function getLogs(req, res, next) {
    var lines = req.query.lines ? parseInt(req.query.lines, 10) : 100;
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a number'));

    var units = req.query.units || 'all';

    var options = {
        lines: lines,
        follow: false,
        units: units.split(','),
        format: req.query.format
    };

    cloudron.getLogs(options, function (error, logStream) {
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
    var lines = req.query.lines ? parseInt(req.query.lines, 10) : -10; // we ignore last-event-id
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a valid number'));

    var units = req.query.units || 'all';

    function sse(id, data) { return 'id: ' + id + '\ndata: ' + data + '\n\n'; }

    if (req.headers.accept !== 'text/event-stream') return next(new HttpError(400, 'This API call requires EventStream'));

    var options = {
        lines: lines,
        follow: true,
        units: units.split(','),
        format: req.query.format
    };

    cloudron.getLogs(options, function (error, logStream) {
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

function sendTestMail(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.email || typeof req.body.email !== 'string') return next(new HttpError(400, 'email must be a non-empty string'));

    mailer.sendTestMail(req.body.email);

    next(new HttpSuccess(202));
}
