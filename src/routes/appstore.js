'use strict';

exports = module.exports = {
    getApps: getApps,
    getApp: getApp,
    getAppVersion: getAppVersion
};

var appstore = require('../appstore.js'),
    AppstoreError = appstore.AppstoreError,
    assert = require('assert'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function getApps(req, res, next) {
    appstore.getApps(function (error, apps) {
        if (error && error.reason === AppstoreError.BILLING_REQUIRED) return next(new HttpError(402, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { apps: apps }));
    });
}

function getApp(req, res, next) {
    assert.strictEqual(typeof req.params.appstoreId, 'string');

    appstore.getApp(req.params.appstoreId, function (error, app) {
        if (error && error.reason === AppstoreError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppstoreError.BILLING_REQUIRED) return next(new HttpError(402, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, app));
    });
}

function getAppVersion(req, res, next) {
    assert.strictEqual(typeof req.params.appstoreId, 'string');
    assert.strictEqual(typeof req.params.versionId, 'string');

    appstore.getAppVersion(req.params.appstoreId, req.params.versionId, function (error, manifest) {
        if (error && error.reason === AppstoreError.NOT_FOUND) return next(new HttpError(404, 'No such app or version'));
        if (error && error.reason === AppstoreError.BILLING_REQUIRED) return next(new HttpError(402, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, manifest));
    });
}
