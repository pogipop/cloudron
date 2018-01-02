'use strict';

exports = module.exports = {
    add: add,
    get: get,
    getAll: getAll,
    update: update,
    del: del,

    setAdmin: setAdmin
};

var assert = require('assert'),
    domains = require('../domains.js'),
    DomainError = domains.DomainError,
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function add(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.domain !== 'string') return next(new HttpError(400, 'domain must be a string'));
    if (typeof req.body.config !== 'object') return next(new HttpError(400, 'config must be an object'));
    if ('zoneName' in req.body && typeof req.body.zoneName !== 'string') return next(new HttpError(400, 'zoneName must be a string'));
    if ('fallbackCertificate' in req.body && typeof req.body.fallbackCertificate !== 'object') return next(new HttpError(400, 'fallbackCertificate must be a object with cert and key strings'));
    if (req.body.fallbackCertificate && (!req.body.cert || typeof req.body.cert !== 'string')) return next(new HttpError(400, 'fallbackCertificate.cert must be a string'));
    if (req.body.fallbackCertificate && (!req.body.key || typeof req.body.key !== 'string')) return next(new HttpError(400, 'fallbackCertificate.key must be a string'));

    domains.add(req.body.domain, req.body.zoneName || req.body.domain, req.body.config, req.body.fallbackCertificate || null, function (error) {
        if (error && error.reason === DomainError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error && error.reason === DomainError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === DomainError.INVALID_PROVIDER) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, { domain: req.body.domain, config: req.body.config }));
    });
}

function get(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    domains.get(req.params.domain, function (error, result) {
        if (error && error.reason === DomainError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, result));
    });
}

function getAll(req, res, next) {
    domains.getAll(function (error, result) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { domains: result }));
    });
}

function update(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.config !== 'object') return next(new HttpError(400, 'config must be an object'));
    if ('fallbackCertificate' in req.body && typeof req.body.fallbackCertificate !== 'object') return next(new HttpError(400, 'fallbackCertificate must be a object with cert and key strings'));
    if (req.body.fallbackCertificate && (!req.body.fallbackCertificate.cert || typeof req.body.fallbackCertificate.cert !== 'string')) return next(new HttpError(400, 'fallbackCertificate.cert must be a string'));
    if (req.body.fallbackCertificate && (!req.body.fallbackCertificate.key || typeof req.body.fallbackCertificate.key !== 'string')) return next(new HttpError(400, 'fallbackCertificate.key must be a string'));

    domains.update(req.params.domain, req.body.config, req.body.fallbackCertificate || null, function (error) {
        if (error && error.reason === DomainError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === DomainError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === DomainError.INVALID_PROVIDER) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204, {}));
    });
}

function del(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    domains.del(req.params.domain, function (error) {
        if (error && error.reason === DomainError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === DomainError.IN_USE) return next(new HttpError(409, 'Domain is still in use'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204, {}));
    });
}

function setAdmin(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    domains.setAdmin(req.params.domain.toLowerCase(), function (error) {
        if (error && error.reason === DomainError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}
