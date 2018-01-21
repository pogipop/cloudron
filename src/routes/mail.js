'use strict';

exports = module.exports = {
    getStatus: getStatus,

    getMailFromValidation: getMailFromValidation,
    setMailFromValidation: setMailFromValidation,

    getCatchAllAddress: getCatchAllAddress,
    setCatchAllAddress: setCatchAllAddress,

    getMailRelay: getMailRelay,
    setMailRelay: setMailRelay,

    getMailConfig: getMailConfig,
    setMailConfig: setMailConfig,
};

var assert = require('assert'),
    mail = require('../mail.js'),
    MailError = mail.MailError,
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function getStatus(req, res, next) {
    mail.getStatus(function (error, records) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, records));
    });
}

function getMailFromValidation(req, res, next) {
    mail.getMailFromValidation(function (error, enabled) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { enabled: enabled }));
    });
}

function setMailFromValidation(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.enabled !== 'boolean') return next(new HttpError(400, 'enabled is required'));

    mail.setMailFromValidation(req.body.enabled, function (error) {
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function getCatchAllAddress(req, res, next) {
    mail.getCatchAllAddress(function (error, address) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { address: address }));
    });
}

function setCatchAllAddress(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.address || !Array.isArray(req.body.address)) return next(new HttpError(400, 'address array is required'));

    for (var i = 0; i < req.body.address.length; i++) {
        if (typeof req.body.address[i] !== 'string') return next(new HttpError(400, 'address must be an array of string'));
    }

    mail.setCatchAllAddress(req.body.address, function (error) {
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function getMailRelay(req, res, next) {
    mail.getMailRelay(function (error, mail) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, mail));
    });
}

function setMailRelay(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.provider !== 'string') return next(new HttpError(400, 'provider is required'));
    if ('host' in req.body && typeof req.body.host !== 'string') return next(new HttpError(400, 'host must be a string'));
    if ('port' in req.body && typeof req.body.port !== 'number') return next(new HttpError(400, 'port must be a string'));
    if ('username' in req.body && typeof req.body.username !== 'string') return next(new HttpError(400, 'username must be a string'));
    if ('password' in req.body && typeof req.body.password !== 'string') return next(new HttpError(400, 'password must be a string'));

    mail.setMailRelay(req.body, function (error) {
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function getMailConfig(req, res, next) {
    mail.getMailConfig(function (error, mail) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, mail));
    });
}

function setMailConfig(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.enabled !== 'boolean') return next(new HttpError(400, 'enabled is required'));

    mail.setMailConfig({ enabled: req.body.enabled }, function (error) {
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}
