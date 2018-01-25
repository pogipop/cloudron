'use strict';

exports = module.exports = {
    get: get,
    update: update,
    list: list,
    create: create,
    remove: remove,
    verifyPassword: verifyPassword,
    requireAdmin: requireAdmin,
    sendInvite: sendInvite,
    setGroups: setGroups
};

var assert = require('assert'),
    clients = require('../clients.js'),
    constants = require('../constants.js'),
    generatePassword = require('../password.js').generate,
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    oauth2 = require('./oauth2.js'),
    user = require('../user.js'),
    UserError = user.UserError,
    util = require('util'),
    _ = require('underscore');

function auditSource(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
}

function create(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.email !== 'string') return next(new HttpError(400, 'email must be string'));
    if (typeof req.body.invite !== 'boolean') return next(new HttpError(400, 'invite must be boolean'));
    if ('username' in req.body && typeof req.body.username !== 'string') return next(new HttpError(400, 'username must be string'));
    if ('displayName' in req.body && typeof req.body.displayName !== 'string') return next(new HttpError(400, 'displayName must be string'));

    var password = generatePassword();
    var email = req.body.email;
    var sendInvite = req.body.invite;
    var username = 'username' in req.body ? req.body.username : null;
    var displayName = req.body.displayName || '';

    user.create(username, password, email, displayName, auditSource(req), { invitor: req.user, sendInvite: sendInvite }, function (error, user) {
        if (error && error.reason === UserError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === UserError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        var userInfo = {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            email: user.email,
            fallbackEmail: user.fallbackEmail,
            admin: user.admin,
            groupIds: [ ],
            resetToken: user.resetToken
        };

        next(new HttpSuccess(201, userInfo ));
    });
}

function update(req, res, next) {
    assert.strictEqual(typeof req.params.userId, 'string');
    assert.strictEqual(typeof req.user, 'object');
    assert.strictEqual(typeof req.body, 'object');

    if ('email' in req.body && typeof req.body.email !== 'string') return next(new HttpError(400, 'email must be string'));
    if ('fallbackEmail' in req.body && typeof req.body.fallbackEmail !== 'string') return next(new HttpError(400, 'fallbackEmail must be string'));
    if ('displayName' in req.body && typeof req.body.displayName !== 'string') return next(new HttpError(400, 'displayName must be string'));
    if ('username' in req.body && typeof req.body.username !== 'string') return next(new HttpError(400, 'username must be a string'));

    if (req.user.id !== req.params.userId && !req.user.admin) return next(new HttpError(403, 'Not allowed'));

    user.update(req.params.userId, req.body, auditSource(req), function (error) {
        if (error && error.reason === UserError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === UserError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error && error.reason === UserError.NOT_FOUND) return next(new HttpError(404, 'User not found'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}

function list(req, res, next) {
    user.list(function (error, results) {
        if (error) return next(new HttpError(500, error));

        var users = results.map(function (result) {
            return _.pick(result, 'id', 'username', 'email', 'fallbackEmail', 'displayName', 'groupIds', 'admin');
        });

        next(new HttpSuccess(200, { users: users }));
    });
}

function get(req, res, next) {
    assert.strictEqual(typeof req.params.userId, 'string');
    assert.strictEqual(typeof req.user, 'object');

    if (req.user.id !== req.params.userId && !req.user.admin) return next(new HttpError(403, 'Not allowed'));

    user.get(req.params.userId, function (error, result) {
        if (error && error.reason === UserError.NOT_FOUND) return next(new HttpError(404, 'No such user'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, {
            id: result.id,
            username: result.username,
            displayName: result.displayName,
            email: result.email,
            fallbackEmail: result.fallbackEmail,
            admin: result.admin,
            groupIds: result.groupIds
        }));
    });
}

function remove(req, res, next) {
    assert.strictEqual(typeof req.params.userId, 'string');

    // rules:
    // - admin can remove any user
    // - admin cannot remove admin
    // - user cannot remove himself <- TODO should this actually work?

    if (req.user.id === req.params.userId) return next(new HttpError(403, 'Not allowed to remove yourself.'));

    user.remove(req.params.userId, auditSource(req), function (error) {
        if (error && error.reason === UserError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === UserError.NOT_FOUND) return next(new HttpError(404, 'No such user'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}

function verifyPassword(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    // using an 'sdk' token we skip password checks
    var error = oauth2.validateRequestedScopes(req, [ clients.SCOPE_ROLE_SDK ]);
    if (!error) return next();

    if (typeof req.body.password !== 'string') return next(new HttpError(400, 'API call requires user password'));

    user.verifyWithUsername(req.user.username, req.body.password, function (error) {
        if (error && error.reason === UserError.WRONG_PASSWORD) return next(new HttpError(403, 'Password incorrect'));
        if (error && error.reason === UserError.NOT_FOUND) return next(new HttpError(403, 'Password incorrect'));
        if (error) return next(new HttpError(500, error));

        req.body.password = '<redacted>'; // this will prevent logs from displaying plain text password

        next();
    });
}

/*
    Middleware which makes the route only accessable for the admin user.
*/
function requireAdmin(req, res, next) {
    assert.strictEqual(typeof req.user, 'object');

    if (!req.user.admin) return next(new HttpError(403, 'API call requires admin rights.'));

    next();
}

function sendInvite(req, res, next) {
    assert.strictEqual(typeof req.params.userId, 'string');

    user.sendInvite(req.params.userId, { invitor: req.user }, function (error, result) {
        if (error && error.reason === UserError.NOT_FOUND) return next(new HttpError(404, 'User not found'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { resetToken: result }));
    });
}

function setGroups(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');
    assert.strictEqual(typeof req.params.userId, 'string');

    if (!Array.isArray(req.body.groupIds)) return next(new HttpError(400, 'API call requires a groups array.'));

    // this route is only allowed for admins, so req.user has to be an admin
    if (req.user.id === req.params.userId && req.body.groupIds.indexOf(constants.ADMIN_GROUP_ID) === -1) return next(new HttpError(403, 'Admin removing itself from admins is not allowed'));

    user.setGroups(req.params.userId, req.body.groupIds, function (error) {
        if (error && error.reason === UserError.NOT_FOUND) return next(new HttpError(404, 'One or more groups not found'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204));
    });
}
