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

function auditSource(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
}

function verifyDomainLock(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    domains.get(req.params.domain, function (error, domain) {
        if (error && error.reason === DomainsError.NOT_FOUND) return next(new HttpError(404, 'No such domain'));
        if (error) return next(new HttpError(500, error));

        if (domain.locked) return next(new HttpError(423, 'This domain is locked'));

        next();
    });
}

function add(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.domain !== 'string') return next(new HttpError(400, 'domain must be a string'));
    if (typeof req.body.provider !== 'string') return next(new HttpError(400, 'provider must be a string'));

    if (!req.body.config || typeof req.body.config !== 'object') return next(new HttpError(400, 'config must be an object'));
    if ('hyphenatedSubdomains' in req.body.config && typeof req.body.config.hyphenatedSubdomains !== 'boolean') return next(new HttpError(400, 'hyphenatedSubdomains must be a boolean'));
    if ('wildcard' in req.body.config && typeof req.body.config.wildcard !== 'boolean') return next(new HttpError(400, 'wildcard must be a boolean'));

    if ('zoneName' in req.body && typeof req.body.zoneName !== 'string') return next(new HttpError(400, 'zoneName must be a string'));
    if ('fallbackCertificate' in req.body && typeof req.body.fallbackCertificate !== 'object') return next(new HttpError(400, 'fallbackCertificate must be a object with cert and key strings'));
    if (req.body.fallbackCertificate) {
        let fallbackCertificate = req.body.fallbackCertificate;
        if (!fallbackCertificate.cert || typeof fallbackCertificate.cert !== 'string') return next(new HttpError(400, 'fallbackCertificate.cert must be a string'));
        if (!fallbackCertificate.key || typeof fallbackCertificate.key !== 'string') return next(new HttpError(400, 'fallbackCertificate.key must be a string'));
        if ('restricted' in fallbackCertificate && typeof fallbackCertificate.restricted !== 'boolean') return next(new HttpError(400, 'fallbackCertificate.restricted must be a boolean'));
    }

    if ('tlsConfig' in req.body) {
        if (!req.body.tlsConfig || typeof req.body.tlsConfig !== 'object') return next(new HttpError(400, 'tlsConfig must be a object with a provider string property'));
        if (!req.body.tlsConfig.provider || typeof req.body.tlsConfig.provider !== 'string') return next(new HttpError(400, 'tlsConfig.provider must be a string'));
    }

    // some DNS providers like DigitalOcean take a really long time to verify credentials (https://github.com/expressjs/timeout/issues/26)
    req.clearTimeout();

    let data = {
        zoneName: req.body.zoneName || '',
        provider: req.body.provider,
        config: req.body.config,
        fallbackCertificate: req.body.fallbackCertificate || null,
        tlsConfig: req.body.tlsConfig || { provider: 'letsencrypt-prod' }
    };

    domains.add(req.body.domain, data, auditSource(req), function (error) {
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
    if ('wildcard' in req.body.config && typeof req.body.config.wildcard !== 'boolean') return next(new HttpError(400, 'wildcard must be a boolean'));

    if ('zoneName' in req.body && typeof req.body.zoneName !== 'string') return next(new HttpError(400, 'zoneName must be a string'));
    if ('fallbackCertificate' in req.body && typeof req.body.fallbackCertificate !== 'object') return next(new HttpError(400, 'fallbackCertificate must be a object with cert and key strings'));
    if (req.body.fallbackCertificate) {
        let fallbackCertificate = req.body.fallbackCertificate;
        if (!fallbackCertificate.cert || typeof fallbackCertificate.cert !== 'string') return next(new HttpError(400, 'fallbackCertificate.cert must be a string'));
        if (!fallbackCertificate.key || typeof fallbackCertificate.key !== 'string') return next(new HttpError(400, 'fallbackCertificate.key must be a string'));
        if ('restricted' in fallbackCertificate && typeof fallbackCertificate.restricted !== 'boolean') return next(new HttpError(400, 'fallbackCertificate.restricted must be a boolean'));
    }

    if ('tlsConfig' in req.body) {
        if (!req.body.tlsConfig || typeof req.body.tlsConfig !== 'object') return next(new HttpError(400, 'tlsConfig must be a object with a provider string property'));
        if (!req.body.tlsConfig.provider || typeof req.body.tlsConfig.provider !== 'string') return next(new HttpError(400, 'tlsConfig.provider must be a string'));
    }

    // some DNS providers like DigitalOcean take a really long time to verify credentials (https://github.com/expressjs/timeout/issues/26)
    req.clearTimeout();

    let data = {
        zoneName: req.body.zoneName || '',
        provider: req.body.provider,
        config: req.body.config,
        fallbackCertificate: req.body.fallbackCertificate || null,
        tlsConfig: req.body.tlsConfig || { provider: 'letsencrypt-prod' }
    };

    domains.update(req.params.domain, data, auditSource(req), function (error) {
        if (error && error.reason === DomainsError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === DomainsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === DomainsError.INVALID_PROVIDER) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204, {}));
    });
}

function del(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    domains.del(req.params.domain, auditSource(req), function (error) {
        if (error && error.reason === DomainsError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === DomainsError.IN_USE) return next(new HttpError(409, 'Domain is still in use. Remove all apps and mailboxes using this domain'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}
