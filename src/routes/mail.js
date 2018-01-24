'use strict';

exports = module.exports = {
    get: get,

    getStatus: getStatus,

    setMailFromValidation: setMailFromValidation,
    setCatchAllAddress: setCatchAllAddress,
    setMailRelay: setMailRelay,
    setMailEnabled: setMailEnabled,

    sendTestMail: sendTestMail,

    getMailboxes: getMailboxes,
    getUserMailbox: getUserMailbox,
    enableUserMailbox: enableUserMailbox,
    disableUserMailbox: disableUserMailbox
};

var assert = require('assert'),
    mail = require('../mail.js'),
    MailError = mail.MailError,
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function get(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.get(req.params.domain, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, result));
    });
}

function getStatus(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.getStatus(req.params.domain, function (error, records) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, records));
    });
}

function setMailFromValidation(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.enabled !== 'boolean') return next(new HttpError(400, 'enabled is required'));

    mail.setMailFromValidation(req.params.domain, req.body.enabled, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function setCatchAllAddress(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.address || !Array.isArray(req.body.address)) return next(new HttpError(400, 'address array is required'));

    for (var i = 0; i < req.body.address.length; i++) {
        if (typeof req.body.address[i] !== 'string') return next(new HttpError(400, 'address must be an array of string'));
    }

    mail.setCatchAllAddress(req.params.domain, req.body.address, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function setMailRelay(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.provider !== 'string') return next(new HttpError(400, 'provider is required'));
    if ('host' in req.body && typeof req.body.host !== 'string') return next(new HttpError(400, 'host must be a string'));
    if ('port' in req.body && typeof req.body.port !== 'number') return next(new HttpError(400, 'port must be a string'));
    if ('username' in req.body && typeof req.body.username !== 'string') return next(new HttpError(400, 'username must be a string'));
    if ('password' in req.body && typeof req.body.password !== 'string') return next(new HttpError(400, 'password must be a string'));

    mail.setMailRelay(req.params.domain, req.body, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function setMailEnabled(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.enabled !== 'boolean') return next(new HttpError(400, 'enabled is required'));

    mail.setMailEnabled(req.params.domain, !!req.body.enabled, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === MailError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function sendTestMail(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.to || typeof req.body.to !== 'string') return next(new HttpError(400, 'to must be a non-empty string'));

    mail.sendTestMail(req.params.domain, req.body.to, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function getMailboxes(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');

    mail.getMailboxes(req.params.domain, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { mailboxes: result }));
    });
}

function getUserMailbox(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.userId, 'string');

    mail.getUserMailbox(req.params.domain, req.params.userId, function (error, result) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { mailbox: result }));
    });
}

function enableUserMailbox(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.userId, 'string');

    mail.enableUserMailbox(req.params.domain, req.params.userId, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, {}));
    });
}

function disableUserMailbox(req, res, next) {
    assert.strictEqual(typeof req.params.domain, 'string');
    assert.strictEqual(typeof req.params.userId, 'string');

    mail.disableUserMailbox(req.params.domain, req.params.userId, function (error) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, {}));
    });
}
