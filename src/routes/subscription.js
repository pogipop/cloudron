'use strict';

exports = module.exports = {
    subscribeCloudron: subscribeCloudron,
    getSubscription: getSubscription
};

var appstore = require('../appstore.js'),
    AppstoreError = appstore.AppstoreError,
    assert = require('assert'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function subscribeCloudron(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.email !== 'string' || !req.body.email) return next(new HttpError(400, 'email must be string'));
    if (typeof req.body.password !== 'string' || !req.body.password) return next(new HttpError(400, 'password must be string'));
    if ('totpToken' in req.body && typeof req.body.totpToken !== 'string') return next(new HttpError(400, 'totpToken must be string'));
    if (typeof req.body.signup !== 'boolean') return next(new HttpError(400, 'signup must be a boolean'));

    appstore.subscribeCloudron(req.body, function (error) {
        if (error && error.reason === AppstoreError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, {}));
    });
}

function getSubscription(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    appstore.getSubscription(function (error, result) {
        if (error && error.reason === AppstoreError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error && error.reason === AppstoreError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, result)); // { email, subscription }
    });
}
