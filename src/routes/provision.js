'use strict';

exports = module.exports = {
    providerTokenAuth: providerTokenAuth,
    setup: setup,
    activate: activate,
    restore: restore,
    getStatus: getStatus
};

var assert = require('assert'),
    auditSource = require('../auditsource'),
    config = require('../config.js'),
    debug = require('debug')('box:routes/setup'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    provision = require('../provision.js'),
    ProvisionError = require('../provision.js').ProvisionError,
    superagent = require('superagent');

function providerTokenAuth(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (config.provider() === 'ami') {
        if (typeof req.body.providerToken !== 'string' || !req.body.providerToken) return next(new HttpError(400, 'providerToken must be a non empty string'));

        superagent.get('http://169.254.169.254/latest/meta-data/instance-id').timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return next(new HttpError(500, error));
            if (result.statusCode !== 200) return next(new HttpError(500, 'Unable to get meta data'));

            if (result.text !== req.body.providerToken) return next(new HttpError(401, 'Invalid providerToken'));

            next();
        });
    } else {
        next();
    }
}

function setup(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.dnsConfig || typeof req.body.dnsConfig !== 'object') return next(new HttpError(400, 'dnsConfig is required'));

    const dnsConfig = req.body.dnsConfig;

    if (typeof dnsConfig.provider !== 'string' || !dnsConfig.provider) return next(new HttpError(400, 'provider is required'));
    if (typeof dnsConfig.domain !== 'string' || !dnsConfig.domain) return next(new HttpError(400, 'domain is required'));

    if ('zoneName' in dnsConfig && typeof dnsConfig.zoneName !== 'string') return next(new HttpError(400, 'zoneName must be a string'));
    if (!dnsConfig.config || typeof dnsConfig.config !== 'object') return next(new HttpError(400, 'config must be an object'));

    if ('tlsConfig' in dnsConfig && typeof dnsConfig.tlsConfig !== 'object') return next(new HttpError(400, 'tlsConfig must be an object'));
    if (dnsConfig.tlsConfig && (!dnsConfig.tlsConfig.provider || typeof dnsConfig.tlsConfig.provider !== 'string')) return next(new HttpError(400, 'tlsConfig.provider must be a string'));

    // TODO: validate subfields of these objects
    if (req.body.autoconf && typeof req.body.autoconf !== 'object') return next(new HttpError(400, 'autoconf must be an object'));

    // it can take sometime to setup DNS, register cloudron
    req.clearTimeout();

    provision.setup(dnsConfig, req.body.autoconf || {}, auditSource.fromRequest(req), function (error) {
        if (error && error.reason === ProvisionError.ALREADY_SETUP) return next(new HttpError(409, error.message));
        if (error && error.reason === ProvisionError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === ProvisionError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200));
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

    provision.activate(username, password, email, displayName, ip, auditSource.fromRequest(req), function (error, info) {
        if (error && error.reason === ProvisionError.ALREADY_PROVISIONED) return next(new HttpError(409, 'Already setup'));
        if (error && error.reason === ProvisionError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, info));
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

    // TODO: validate subfields of these objects
    if (req.body.autoconf && typeof req.body.autoconf !== 'object') return next(new HttpError(400, 'autoconf must be an object'));

    provision.restore(backupConfig, req.body.backupId, req.body.version, req.body.autoconf || {}, auditSource.fromRequest(req), function (error) {
        if (error && error.reason === ProvisionError.ALREADY_SETUP) return next(new HttpError(409, error.message));
        if (error && error.reason === ProvisionError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === ProvisionError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error && error.reason === ProvisionError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200));
    });
}

function getStatus(req, res, next) {
    provision.getStatus(function (error, status) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, status));
    });
}
