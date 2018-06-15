'use strict';

exports = module.exports = {
    SCOPE_APPS: 'apps',
    SCOPE_CLIENTS: 'clients',
    SCOPE_CLOUDRON: 'cloudron',
    SCOPE_DOMAINS: 'domains',
    SCOPE_MAIL: 'mail',
    SCOPE_PROFILE: 'profile',
    SCOPE_SETTINGS: 'settings',
    SCOPE_USERS: 'users',
    VALID_SCOPES: [ 'apps', 'clients', 'cloudron', 'domains', 'mail', 'profile', 'settings', 'users' ],

    SCOPE_ANY: '*',

    ROLE_OWNER: 'owner',

    initialize: initialize,
    uninitialize: uninitialize,

    accessTokenAuth: accessTokenAuth,

    validateRoles: validateRoles,

    validateScope: validateScope,
    hasScopes: hasScopes,
    intersectScope: intersectScope,
    canonicalScope: canonicalScope
};

var assert = require('assert'),
    BasicStrategy = require('passport-http').BasicStrategy,
    BearerStrategy = require('passport-http-bearer').Strategy,
    clients = require('./clients'),
    ClientPasswordStrategy = require('passport-oauth2-client-password').Strategy,
    ClientsError = clients.ClientsError,
    DatabaseError = require('./databaseerror'),
    debug = require('debug')('box:accesscontrol'),
    LocalStrategy = require('passport-local').Strategy,
    passport = require('passport'),
    tokendb = require('./tokendb'),
    users = require('./users.js'),
    UsersError = users.UsersError,
    _ = require('underscore');

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    passport.serializeUser(function (user, callback) {
        callback(null, user.id);
    });

    passport.deserializeUser(function(userId, callback) {
        users.get(userId, function (error, result) {
            if (error) return callback(error);

            callback(null, result);
        });
    });

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

    passport.use(new BasicStrategy(function (username, password, callback) {
        if (username.indexOf('cid-') === 0) {
            debug('BasicStrategy: detected client id %s instead of username:password', username);
            // username is actually client id here
            // password is client secret
            clients.get(username, function (error, client) {
                if (error && error.reason === ClientsError.NOT_FOUND) return callback(null, false);
                if (error) return callback(error);
                if (client.clientSecret != password) return callback(null, false);
                return callback(null, client);
            });
        } else {
            users.verifyWithUsername(username, password, function (error, result) {
                if (error && error.reason === UsersError.NOT_FOUND) return callback(null, false);
                if (error && error.reason === UsersError.WRONG_PASSWORD) return callback(null, false);
                if (error) return callback(error);
                if (!result) return callback(null, false);
                callback(null, result);
            });
        }
    }));

    passport.use(new ClientPasswordStrategy(function (clientId, clientSecret, callback) {
        clients.get(clientId, function(error, client) {
            if (error && error.reason === ClientsError.NOT_FOUND) return callback(null, false);
            if (error) { return callback(error); }
            if (client.clientSecret != clientSecret) { return callback(null, false); }
            return callback(null, client);
        });
    }));

    passport.use(new BearerStrategy(accessTokenAuth));

    callback(null);
}

function uninitialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    callback(null);
}

function canonicalScope(scope) {
    var scopes = scope.split(',');
    scopes = scopes.map(function (s) { return s.replace(exports.SCOPE_ANY, exports.VALID_SCOPES.join(',')); });
    return scopes.join(',');
}

function intersectScope(allowedScope, wantedScope) {
    assert.strictEqual(typeof allowedScope, 'string');
    assert.strictEqual(typeof wantedScope, 'string');

    const allowedScopes = allowedScope.split(',');
    const wantedScopes = wantedScope.split(',');

    if (allowedScopes.indexOf(exports.SCOPE_ANY) !== -1) return canonicalScope(wantedScope);
    if (wantedScopes.indexOf(exports.SCOPE_ANY) !== -1) return canonicalScope(allowedScope);

    return _.intersection(allowedScopes, wantedScopes).join(',');
}

function accessTokenAuth(accessToken, callback) {
    assert.strictEqual(typeof accessToken, 'string');
    assert.strictEqual(typeof callback, 'function');

    tokendb.get(accessToken, function (error, token) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, false);
        if (error) return callback(error);

        users.get(token.identifier, function (error, user) {
            if (error && error.reason === UsersError.NOT_FOUND) return callback(null, false);
            if (error) return callback(error);

            // scopes here can define what capabilities that token carries
            // passport put the 'info' object into req.authInfo, where we can further validate the scopes
            var scope = intersectScope(user.scope, token.scope);
            var info = { scope: scope, clientId: token.clientId };

            callback(null, user, info);
        });
    });
}

function validateRoles(roles) {
    assert(Array.isArray(roles));

    if (roles.length === 0) return null;
    if (roles.length === 1 && roles[0] === exports.ROLE_OWNER) return null;

    return new Error('Invalid role');
}

function validateScope(scope) {
    assert.strictEqual(typeof scope, 'string');

    if (scope === '') return new Error('Empty scope not allowed');

    // NOTE: this function intentionally does not allow '*'. This is only allowed in the db to allow
    // us not write a migration script every time we add a new scope
    var allValid = scope.split(',').every(function (s) { return exports.VALID_SCOPES.indexOf(s.split(':')[0]) !== -1; });
    if (!allValid) return new Error('Invalid scope. Available scopes are ' + exports.VALID_SCOPES.join(', '));

    return null;
}

// tests if all requiredScopes are attached to the request
function hasScopes(authInfo, requiredScopes) {
    assert.strictEqual(typeof authInfo, 'object');
    assert(Array.isArray(requiredScopes), 'Expecting array');

    if (!authInfo || !authInfo.scope) return new Error('No scope found');

    var scopes = authInfo.scope.split(',');

    if (scopes.indexOf(exports.SCOPE_ANY) !== -1) return null;

    for (var i = 0; i < requiredScopes.length; ++i) {
        const scopeParts = requiredScopes[i].split(':');

        // this allows apps:write if the token has a higher apps scope
        if (scopes.indexOf(requiredScopes[i]) === -1 && scopes.indexOf(scopeParts[0]) === -1) {
            debug('scope: missing scope "%s".', requiredScopes[i]);
            return new Error('Missing required scope "' + requiredScopes[i] + '"');
        }
    }

    return null;
}
