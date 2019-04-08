'use strict';

exports = module.exports = {
    feedback: feedback,

    getRemoteSupport: getRemoteSupport,
    enableRemoteSupport: enableRemoteSupport
};

var appstore = require('../appstore.js'),
    AppstoreError = require('../appstore.js').AppstoreError,
    assert = require('assert'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    support = require('../support.js'),
    _ = require('underscore');

function feedback(req, res, next) {
    assert.strictEqual(typeof req.user, 'object');

    const VALID_TYPES = [ 'feedback', 'ticket', 'app_missing', 'app_error', 'upgrade_request' ];

    if (typeof req.body.type !== 'string' || !req.body.type) return next(new HttpError(400, 'type must be string'));
    if (VALID_TYPES.indexOf(req.body.type) === -1) return next(new HttpError(400, 'unknown type'));
    if (typeof req.body.subject !== 'string' || !req.body.subject) return next(new HttpError(400, 'subject must be string'));
    if (typeof req.body.description !== 'string' || !req.body.description) return next(new HttpError(400, 'description must be string'));
    if (req.body.appId && typeof req.body.appId !== 'string') return next(new HttpError(400, 'appId must be string'));

    appstore.sendFeedback(_.extend({ }, req.body, { email: req.user.email, displayName: req.user.displayName }), function (error) {
        if (error && error.reason === AppstoreError.BILLING_REQUIRED) return next(new HttpError(402, 'Login to App Store to create support tickets. You can also email support@cloudron.io'));
        if (error) return next(new HttpError(503, 'Error contacting cloudron.io. Please email support@cloudron.io'));

        next(new HttpSuccess(201, {}));
    });
}

function enableRemoteSupport(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.enable !== 'boolean') return next(new HttpError(400, 'enabled is required'));

    support.enableRemoteSupport(req.body.enable, function (error) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}

function getRemoteSupport(req, res, next) {
    support.getRemoteSupport(function (error, status) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, status));
    });
}
