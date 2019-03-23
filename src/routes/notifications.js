'use strict';

exports = module.exports = {
    verifyOwnership: verifyOwnership,
    get: get,
    list: list,
    ack: ack
};

let assert = require('assert'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    notifications = require('../notifications.js'),
    NotificationsError = notifications.NotificationsError;

function verifyOwnership(req, res, next) {
    if (!req.params.notificationId) return next();  // skip for listing

    notifications.get(req.params.notificationId, function (error, result) {
        if (error && error.reason === NotificationsError.NOT_FOUND) return next(new HttpError(404, 'No such notification'));
        if (error) return next(new HttpError(500, error));

        if (result.userId !== req.user.id) return next(new HttpError(403, 'User is not owner'));

        req.notification = result;

        next();
    });
}

function get(req, res, next) {
    assert.strictEqual(typeof req.notification, 'object');

    next(new HttpSuccess(200, { notification: req.notification }));
}

function list(req, res, next) {
    var page = typeof req.query.page !== 'undefined' ? parseInt(req.query.page) : 1;
    if (!page || page < 0) return next(new HttpError(400, 'page query param has to be a postive number'));

    var perPage = typeof req.query.per_page !== 'undefined'? parseInt(req.query.per_page) : 25;
    if (!perPage || perPage < 0) return next(new HttpError(400, 'per_page query param has to be a postive number'));

    var acknowledged = null;
    if (req.query.acknowledged && !(req.query.acknowledged === 'true' || req.query.acknowledged === 'false')) return next(new HttpError(400, 'acknowledged must be a true or false'));
    else if (req.query.acknowledged) acknowledged = req.query.acknowledged === 'true' ? true : false;

    notifications.getAllPaged(req.user.id, acknowledged, page, perPage, function (error, result) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { notifications: result }));
    });
}

function ack(req, res, next) {
    assert.strictEqual(typeof req.params.notificationId, 'string');

    notifications.ack(req.params.notificationId, function (error) {
        if (error && error.reason === NotificationsError.NOT_FOUND) return next(new HttpError(404, 'No such notification'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204, {}));
    });
}
