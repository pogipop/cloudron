'use strict';

exports = module.exports = {
    add: add,
    get: get,
    getAll: getAll,
    update: update,
    del: del
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

    domains.add(req.body.domain, req.body.zoneName || req.body.domain, req.body.config, function (error) {
        if (error && error.reason === DomainError.ALREADY_EXISTS) return next(new HttpError(400, error.message));
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

    domains.update(req.params.domain, req.body.config, function (error) {
        if (error && error.reason === DomainError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204, {}));
    });
}

function del(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    domains.del(req.params.domain, function (error) {
        if (error && error.reason === DomainError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204, {}));
    });
}
