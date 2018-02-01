'use strict';

exports = module.exports = {
    providerTokenAuth: providerTokenAuth,
    setupTokenAuth: setupTokenAuth,
    dnsSetup: dnsSetup,
    activate: activate,
    restore: restore,
    getStatus: getStatus,
};

var assert = require('assert'),
    caas = require('../caas.js'),
    CaasError = require('../caas.js').CaasError,
    config = require('../config.js'),
    debug = require('debug')('box:routes/setup'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    setup = require('../setup.js'),
    SetupError = require('../setup.js').SetupError,
    superagent = require('superagent');

function auditSource(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
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

function dnsSetup(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.provider !== 'string' || !req.body.provider) return next(new HttpError(400, 'provider is required'));
    if (typeof req.body.domain !== 'string' || !req.body.domain) return next(new HttpError(400, 'domain is required'));
    if (typeof req.body.adminFqdn !== 'string' || !req.body.adminFqdn) return next(new HttpError(400, 'adminFqdn is required'));

    if ('zoneName' in req.body && typeof req.body.zoneName !== 'string') return next(new HttpError(400, 'zoneName must be a string'));
    if (!req.body.config || typeof req.body.config !== 'object') return next(new HttpError(400, 'config must be an object'));

    if ('tlsConfig' in req.body && typeof req.body.tlsConfig !== 'object') return next(new HttpError(400, 'tlsConfig must be an object'));
    if (req.body.tlsConfig && (!req.body.tlsConfig.provider || typeof req.body.tlsConfig.provider !== 'string')) return next(new HttpError(400, 'tlsConfig.provider must be a string'));

    setup.dnsSetup(req.body.adminFqdn.toLowerCase(), req.body.domain.toLowerCase(), req.body.zoneName || '', req.body.provider, req.body.config, req.body.tlsConfig || { provider: 'letsencrypt-prod' }, function (error) {
        if (error && error.reason === SetupError.ALREADY_SETUP) return next(new HttpError(409, error.message));
        if (error && error.reason === SetupError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200));
    });
}

function getStatus(req, res, next) {
    setup.getStatus(function (error, status) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, status));
    });
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

    setup.activate(username, password, email, displayName, ip, auditSource(req), function (error, info) {
        if (error && error.reason === SetupError.ALREADY_PROVISIONED) return next(new HttpError(409, 'Already setup'));
        if (error && error.reason === SetupError.BAD_FIELD) return next(new HttpError(400, error.message));
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

    setup.restore(backupConfig, req.body.backupId, req.body.version, function (error) {
        if (error && error.reason === SetupError.ALREADY_SETUP) return next(new HttpError(409, error.message));
        if (error && error.reason === SetupError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === SetupError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error && error.reason === SetupError.EXTERNAL_ERROR) return next(new HttpError(402, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200));
    });
}
