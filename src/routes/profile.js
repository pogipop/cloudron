'use strict';

exports = module.exports = {
    get: get,
    update: update,
    changePassword: changePassword,
    setTwoFactorAuthenticationSecret: setTwoFactorAuthenticationSecret,
    enableTwoFactorAuthentication: enableTwoFactorAuthentication,
    disableTwoFactorAuthentication: disableTwoFactorAuthentication
};

var accesscontrol = require('../accesscontrol.js'),
    assert = require('assert'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    users = require('../users.js'),
    UsersError = users.UsersError,
    _ = require('underscore');

function auditSource(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
}

function get(req, res, next) {
    assert.strictEqual(typeof req.user, 'object');

    next(new HttpSuccess(200, {
        id: req.user.id,
        username: req.user.username,
        email: req.user.email,
        fallbackEmail: req.user.fallbackEmail,
        admin: req.user.admin,
        scope: accesscontrol.canonicalScope(req.authInfo.scope), // this returns the token scope and not the user's scope
        displayName: req.user.displayName,
        twoFactorAuthenticationEnabled: req.user.twoFactorAuthenticationEnabled
    }));
}

function update(req, res, next) {
    assert.strictEqual(typeof req.user, 'object');
    assert.strictEqual(typeof req.body, 'object');

    if ('email' in req.body && typeof req.body.email !== 'string') return next(new HttpError(400, 'email must be string'));
    if ('fallbackEmail' in req.body && typeof req.body.fallbackEmail !== 'string') return next(new HttpError(400, 'fallbackEmail must be string'));
    if ('displayName' in req.body && typeof req.body.displayName !== 'string') return next(new HttpError(400, 'displayName must be string'));

    var data = _.pick(req.body, 'email', 'fallbackEmail', 'displayName');

    users.update(req.user.id, data, auditSource(req), function (error) {
        if (error && error.reason === UsersError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === UsersError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error && error.reason === UsersError.NOT_FOUND) return next(new HttpError(404, 'User not found'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}

function changePassword(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');
    assert.strictEqual(typeof req.user, 'object');

    if (typeof req.body.newPassword !== 'string') return next(new HttpError(400, 'newPassword must be a string'));

    users.setPassword(req.user.id, req.body.newPassword, function (error) {
        if (error && error.reason === UsersError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === UsersError.NOT_FOUND) return next(new HttpError(403, 'Wrong password'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}

function setTwoFactorAuthenticationSecret(req, res, next) {
    assert.strictEqual(typeof req.user, 'object');

    users.setTwoFactorAuthenticationSecret(req.user.id, function (error, result) {
        if (error && error.reason === UsersError.ALREADY_EXISTS) return next(new HttpError(409, 'TwoFactor Authentication is enabled, disable first'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, { secret: result.secret, qrcode: result.qrcode }));
    });
}

function enableTwoFactorAuthentication(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');
    assert.strictEqual(typeof req.user, 'object');

    if (!req.body.totpToken || typeof req.body.totpToken !== 'string') return next(new HttpError(400, 'totpToken must be a nonempty string'));

    users.enableTwoFactorAuthentication(req.user.id, req.body.totpToken, function (error) {
        if (error && error.reason === UsersError.NOT_FOUND) return next(new HttpError(404, 'User not found'));
        if (error && error.reason === UsersError.BAD_TOKEN) return next(new HttpError(403, 'Invalid token'));
        if (error && error.reason === UsersError.ALREADY_EXISTS) return next(new HttpError(409, 'TwoFactor Authentication is already enabled'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}

function disableTwoFactorAuthentication(req, res, next) {
    assert.strictEqual(typeof req.user, 'object');

    users.disableTwoFactorAuthentication(req.user.id, function (error) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}
