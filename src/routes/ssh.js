'use strict';

exports = module.exports = {
    getAuthorizedKeys: getAuthorizedKeys,
    getAuthorizedKey: getAuthorizedKey,
    addAuthorizedKey: addAuthorizedKey,
    delAuthorizedKey: delAuthorizedKey
};

var assert = require('assert'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    ssh = require('../ssh.js'),
    SshError = ssh.SshError;

function getAuthorizedKeys(req, res, next) {
    ssh.getAuthorizedKeys(function (error, result) {
        if (error) return next(new HttpError(500, error));
        next(new HttpSuccess(200, { keys: result }));
    });
}

function getAuthorizedKey(req, res, next) {
    assert.strictEqual(typeof req.params.identifier, 'string');

    ssh.getAuthorizedKey(req.params.identifier, function (error, result) {
        if (error && error.reason === SshError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));
        next(new HttpSuccess(200, { identifier: result.identifier, key: result.key }));
    });
}

function addAuthorizedKey(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.key !== 'string' || !req.body.key) return next(new HttpError(400, 'key must be a non empty'));

    ssh.addAuthorizedKey(req.body.key, function (error) {
        if (error && error.reason === SshError.INVALID_KEY) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, {}));
    });
}

function delAuthorizedKey(req, res, next) {
    assert.strictEqual(typeof req.params.identifier, 'string');

    ssh.delAuthorizedKey(req.params.identifier, function (error) {
        if (error && error.reason === SshError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));
        next(new HttpSuccess(202, {}));
    });
}
