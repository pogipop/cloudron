'use strict';

exports = module.exports = {
    initialize: initialize,
    uninitialize: uninitialize,

    scope: scope,
    websocketAuth: websocketAuth
};

var accesscontrol = require('../accesscontrol.js'),
    assert = require('assert'),
    BasicStrategy = require('passport-http').BasicStrategy,
    BearerStrategy = require('passport-http-bearer').Strategy,
    clients = require('../clients.js'),
    ClientPasswordStrategy = require('passport-oauth2-client-password').Strategy,
    ClientsError = clients.ClientsError,
    HttpError = require('connect-lastmile').HttpError,
    LocalStrategy = require('passport-local').Strategy,
    passport = require('passport'),
    users = require('../users.js'),
    UsersError = users.UsersError;

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    // serialize user into session
    passport.serializeUser(function (user, callback) {
        callback(null, user.id);
    });

    // deserialize user from session
    passport.deserializeUser(function(userId, callback) {
        users.get(userId, function (error, result) {
            if (error) return callback(error);

            callback(null, result);
        });
    });

    // used when username/password is sent in request body. used in CLI tool login route
    passport.use(new LocalStrategy(function (username, password, callback) {
        if (username.indexOf('@') === -1) {
            users.verifyWithUsername(username, password, function (error, result) {
                if (error && error.reason === UsersError.NOT_FOUND) return callback(null, false);
                if (error && error.reason === UsersError.WRONG_PASSWORD) return callback(null, false);
                if (error) return callback(error);
                if (!result) return callback(null, false);
                callback(null, result);
            });
        } else {
            users.verifyWithEmail(username, password, function (error, result) {
                if (error && error.reason === UsersError.NOT_FOUND) return callback(null, false);
                if (error && error.reason === UsersError.WRONG_PASSWORD) return callback(null, false);
                if (error) return callback(error);
                if (!result) return callback(null, false);
                callback(null, result);
            });
        }
    }));

    // Used to authenticate a OAuth2 client which uses clientId and clientSecret in the Authorization header
    passport.use(new BasicStrategy(function (clientId, clientSecret, callback) {
        clients.get(clientId, function (error, client) {
            if (error && error.reason === ClientsError.NOT_FOUND) return callback(null, false);
            if (error) return callback(error);
            if (client.clientSecret !== clientSecret) return callback(null, false);
            callback(null, client);
        });
    }));

    // Used to authenticate a OAuth2 client which uses clientId and clientSecret in the request body (client_id, client_secret)
    passport.use(new ClientPasswordStrategy(function (clientId, clientSecret, callback) {
        clients.get(clientId, function(error, client) {
            if (error && error.reason === ClientsError.NOT_FOUND) return callback(null, false);
            if (error) { return callback(error); }
            if (client.clientSecret !== clientSecret) { return callback(null, false); }
            callback(null, client);
        });
    }));

    // used for "Authorization: Bearer token" or access_token query param authentication
    passport.use(new BearerStrategy(function (token, callback) {
        accesscontrol.validateToken(token, callback);
    }));

    callback(null);
}

function uninitialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    callback(null);
}

//  The scope middleware provides an auth middleware for routes.
//
//  It is used for API routes, which are authenticated using accesstokens.
//  Those accesstokens carry OAuth scopes and the middleware takes the required
//  scope as an argument and will verify the accesstoken against it.
//
//  See server.js:
//    var profileScope = routes.oauth2.scope('profile');
//
function scope(requiredScope) {
    assert.strictEqual(typeof requiredScope, 'string');

    var requiredScopes = requiredScope.split(',');

    return [
        passport.authenticate(['bearer'], { session: false }),

        function (req, res, next) {
            assert(req.authInfo && typeof req.authInfo === 'object');

            var error = accesscontrol.hasScopes(req.authInfo.authorizedScopes, requiredScopes);
            if (error) return next(new HttpError(403, error.message));

            next();
        }
    ];
}

function websocketAuth(requiredScopes, req, res, next) {
    assert(Array.isArray(requiredScopes));

    if (typeof req.query.access_token !== 'string') return next(new HttpError(401, 'Unauthorized'));

    accesscontrol.validateToken(req.query.access_token, function (error, user, info) {
        if (error) return next(new HttpError(500, error.message));
        if (!user) return next(new HttpError(401, 'Unauthorized'));

        req.user = user;

        var e = accesscontrol.hasScopes(info.authorizedScopes, requiredScopes);
        if (e) return next(new HttpError(403, e.message));

        next();
    });
}
