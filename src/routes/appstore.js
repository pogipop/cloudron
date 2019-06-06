'use strict';

exports = module.exports = {
    getApps: getApps,
    getApp: getApp,
    getAppVersion: getAppVersion,

    registerCloudron: registerCloudron,
    getSubscription: getSubscription
};

var appstore = require('../appstore.js'),
    AppstoreError = appstore.AppstoreError,
    assert = require('assert'),
    custom = require('../custom.js'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function isAppAllowed(appstoreId) {
    if (custom.spec().appstore.blacklist.includes(appstoreId)) return false;

    if (!custom.spec().appstore.whitelist) return true;
    if (!custom.spec().appstore.whitelist[appstoreId]) return false;

    return true;
}

function getApps(req, res, next) {
    appstore.getApps(function (error, apps) {
        if (error && error.reason === AppstoreError.INVALID_TOKEN) return next(new HttpError(402, error.message));
        if (error && error.reason === AppstoreError.LICENSE_ERROR) return next(new HttpError(402, error.message));
        if (error && error.reason === AppstoreError.NOT_REGISTERED) return next(new HttpError(412, error.message));
        if (error) return next(new HttpError(500, error));

        let filteredApps = apps.filter((app) => !custom.spec().appstore.blacklist.includes(app.id));
        if (custom.spec().appstore.whitelist) filteredApps = filteredApps.filter((app) => app.id in custom.spec().appstore.whitelist);

        next(new HttpSuccess(200, { apps: filteredApps }));
    });
}

function getApp(req, res, next) {
    assert.strictEqual(typeof req.params.appstoreId, 'string');

    if (!isAppAllowed(req.params.appstoreId)) return next(new HttpError(405, 'feature disabled by admin'));

    appstore.getApp(req.params.appstoreId, function (error, app) {
        if (error && error.reason === AppstoreError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppstoreError.INVALID_TOKEN) return next(new HttpError(402, error.message));
        if (error && error.reason === AppstoreError.LICENSE_ERROR) return next(new HttpError(402, error.message));
        if (error && error.reason === AppstoreError.NOT_REGISTERED) return next(new HttpError(412, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, app));
    });
}

function getAppVersion(req, res, next) {
    assert.strictEqual(typeof req.params.appstoreId, 'string');
    assert.strictEqual(typeof req.params.versionId, 'string');

    if (!isAppAllowed(req.params.appstoreId)) return next(new HttpError(405, 'feature disabled by admin'));

    appstore.getAppVersion(req.params.appstoreId, req.params.versionId, function (error, manifest) {
        if (error && error.reason === AppstoreError.NOT_FOUND) return next(new HttpError(404, 'No such app or version'));
        if (error && error.reason === AppstoreError.INVALID_TOKEN) return next(new HttpError(402, error.message));
        if (error && error.reason === AppstoreError.LICENSE_ERROR) return next(new HttpError(402, error.message));
        if (error && error.reason === AppstoreError.NOT_REGISTERED) return next(new HttpError(412, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, manifest));
    });
}

function registerCloudron(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.email !== 'string' || !req.body.email) return next(new HttpError(400, 'email must be string'));
    if (typeof req.body.password !== 'string' || !req.body.password) return next(new HttpError(400, 'password must be string'));
    if ('totpToken' in req.body && typeof req.body.totpToken !== 'string') return next(new HttpError(400, 'totpToken must be string'));
    if (typeof req.body.signup !== 'boolean') return next(new HttpError(400, 'signup must be a boolean'));

    appstore.registerWithLoginCredentials(req.body, function (error) {
        if (error && error.reason === AppstoreError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error && error.reason === AppstoreError.ACCESS_DENIED) return next(new HttpError(412, error.message));
        if (error && error.reason === AppstoreError.ALREADY_REGISTERED) return next(new HttpError(422, error.message));
        if (error && error.reason === AppstoreError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, {}));
    });
}

function getSubscription(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    appstore.getSubscription(function (error, result) {
        if (error && error.reason === AppstoreError.INVALID_TOKEN) return next(new HttpError(402, error.message));
        if (error && error.reason === AppstoreError.NOT_REGISTERED) return next(new HttpError(412, error.message));
        if (error && error.reason === AppstoreError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, result)); // { email, cloudronId, plan, cancel_at, status }
    });
}
