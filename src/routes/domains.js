'use strict';

exports = module.exports = {
    add: add,
    get: get,
    getAll: getAll,
    update: update,
    del: del,

    verifyDomainLock: verifyDomainLock
};

var assert = require('assert'),
    domains = require('../domains.js'),
    DomainsError = domains.DomainsError,
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function verifyDomainLock(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    if (domains.isLocked(req.params.domain)) return next(new HttpError(423, 'This domain is locked'));

    next();
}

function add(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.domain !== 'string') return next(new HttpError(400, 'domain must be a string'));
    if (typeof req.body.provider !== 'string') return next(new HttpError(400, 'provider must be a string'));

    if (!req.body.config || typeof req.body.config !== 'object') return next(new HttpError(400, 'config must be an object'));
    if ('hyphenatedSubdomains' in req.body.config && typeof req.body.config.hyphenatedSubdomains !== 'boolean') return next(new HttpError(400, 'hyphenatedSubdomains must be a boolean'));

    if ('zoneName' in req.body && typeof req.body.zoneName !== 'string') return next(new HttpError(400, 'zoneName must be a string'));
    if ('fallbackCertificate' in req.body && typeof req.body.fallbackCertificate !== 'object') return next(new HttpError(400, 'fallbackCertificate must be a object with cert and key strings'));
    if (req.body.fallbackCertificate && (!req.body.cert || typeof req.body.cert !== 'string')) return next(new HttpError(400, 'fallbackCertificate.cert must be a string'));
    if (req.body.fallbackCertificate && (!req.body.key || typeof req.body.key !== 'string')) return next(new HttpError(400, 'fallbackCertificate.key must be a string'));

    if ('tlsConfig' in req.body) {
        if (!req.body.tlsConfig || typeof req.body.tlsConfig !== 'object') return next(new HttpError(400, 'tlsConfig must be a object with a provider string property'));
        if (!req.body.tlsConfig.provider || typeof req.body.tlsConfig.provider !== 'string') return next(new HttpError(400, 'tlsConfig.provider must be a string'));
    }

    // some DNS providers like DigitalOcean take a really long time to verify credentials (https://github.com/expressjs/timeout/issues/26)
    req.clearTimeout();

    domains.add(req.body.domain, req.body.zoneName || '', req.body.provider, req.body.config, req.body.fallbackCertificate || null, req.body.tlsConfig || { provider: 'letsencrypt-prod' }, function (error) {
        if (error && error.reason === DomainsError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error && error.reason === DomainsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === DomainsError.INVALID_PROVIDER) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, { domain: req.body.domain, config: req.body.config }));
    });
}

function get(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    domains.get(req.params.domain, function (error, result) {
        if (error && error.reason === DomainsError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, domains.removePrivateFields(result)));
    });
}

function getAll(req, res, next) {
    domains.getAll(function (error, result) {
        if (error) return next(new HttpError(500, error));

        result = result.map(domains.removeRestrictedFields);

        next(new HttpSuccess(200, { domains: result }));
    });
}

function update(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.provider !== 'string') return next(new HttpError(400, 'provider must be an object'));

    if (!req.body.config || typeof req.body.config !== 'object') return next(new HttpError(400, 'config must be an object'));
    if ('hyphenatedSubdomains' in req.body.config && typeof req.body.config.hyphenatedSubdomains !== 'boolean') return next(new HttpError(400, 'hyphenatedSubdomains must be a boolean'));

    if ('zoneName' in req.body && typeof req.body.zoneName !== 'string') return next(new HttpError(400, 'zoneName must be a string'));
    if ('fallbackCertificate' in req.body && typeof req.body.fallbackCertificate !== 'object') return next(new HttpError(400, 'fallbackCertificate must be a object with cert and key strings'));
    if (req.body.fallbackCertificate && (!req.body.fallbackCertificate.cert || typeof req.body.fallbackCertificate.cert !== 'string')) return next(new HttpError(400, 'fallbackCertificate.cert must be a string'));
    if (req.body.fallbackCertificate && (!req.body.fallbackCertificate.key || typeof req.body.fallbackCertificate.key !== 'string')) return next(new HttpError(400, 'fallbackCertificate.key must be a string'));

    if ('tlsConfig' in req.body) {
        if (!req.body.tlsConfig || typeof req.body.tlsConfig !== 'object') return next(new HttpError(400, 'tlsConfig must be a object with a provider string property'));
        if (!req.body.tlsConfig.provider || typeof req.body.tlsConfig.provider !== 'string') return next(new HttpError(400, 'tlsConfig.provider must be a string'));
    }

    // some DNS providers like DigitalOcean take a really long time to verify credentials (https://github.com/expressjs/timeout/issues/26)
    req.clearTimeout();

    domains.update(req.params.domain, req.body.zoneName || '', req.body.provider, req.body.config, req.body.fallbackCertificate || null, req.body.tlsConfig || { provider: 'letsencrypt-prod' }, function (error) {
        if (error && error.reason === DomainsError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === DomainsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === DomainsError.INVALID_PROVIDER) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204, {}));
    });
}

function del(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    domains.del(req.params.domain, function (error) {
        if (error && error.reason === DomainsError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === DomainsError.IN_USE) return next(new HttpError(409, 'Domain is still in use. Remove all apps and mailboxes using this domain'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}
