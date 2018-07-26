'use strict';

exports = module.exports = {
    SCOPE_APPS_READ: 'apps:read',
    SCOPE_APPS_MANAGE: 'apps:manage',
    SCOPE_CLIENTS: 'clients',
    SCOPE_CLOUDRON: 'cloudron',
    SCOPE_DOMAINS_READ: 'domains:read',
    SCOPE_DOMAINS_MANAGE: 'domains:manage',
    SCOPE_MAIL: 'mail',
    SCOPE_PROFILE: 'profile',
    SCOPE_SETTINGS: 'settings',
    SCOPE_USERS_READ: 'users:read',
    SCOPE_USERS_MANAGE: 'users:manage',
    SCOPE_APPSTORE: 'appstore',
    VALID_SCOPES: [ 'apps', 'appstore', 'clients', 'cloudron', 'domains', 'mail', 'profile', 'settings', 'users' ], // keep this sorted

    SCOPE_ANY: '*',

    validateScopeString: validateScopeString,
    hasScopes: hasScopes,
    canonicalScopeString: canonicalScopeString,
    intersectScopes: intersectScopes,
    validateToken: validateToken,
    scopesForUser: scopesForUser
};

var assert = require('assert'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:accesscontrol'),
    tokendb = require('./tokendb.js'),
    users = require('./users.js'),
    UsersError = users.UsersError,
    _ = require('underscore');

// returns scopes that does not have wildcards and is sorted
function canonicalScopeString(scope) {
    if (scope === exports.SCOPE_ANY) return exports.VALID_SCOPES.join(',');

    return scope.split(',').sort().join(',');
}

function intersectScopes(allowedScopes, wantedScopes) {
    assert(Array.isArray(allowedScopes), 'Expecting sorted array');
    assert(Array.isArray(wantedScopes), 'Expecting sorted array');

    if (_.isEqual(allowedScopes, wantedScopes)) return allowedScopes; // quick path

    let wantedScopesMap = new Map();
    let results = [];

    // make a map of scope -> [ subscopes ]
    for (let w of wantedScopes) {
        let parts = w.split(':');
        let subscopes = wantedScopesMap.get(parts[0]) || new Set();
        subscopes.add(parts[1] || '*');
        wantedScopesMap.set(parts[0], subscopes);
    }

    for (let a of allowedScopes) {
        let parts = a.split(':');
        let as = parts[1] || '*';

        let subscopes = wantedScopesMap.get(parts[0]);
        if (!subscopes) continue;

        if (subscopes.has('*') || subscopes.has(as)) {
            results.push(a);
        } else if (as === '*') {
            results = results.concat(Array.from(subscopes).map(function (ss) { return `${a}:${ss}`; }));
        }
    }

    return results;
}

function validateScopeString(scope) {
    assert.strictEqual(typeof scope, 'string');

    if (scope === '') return new Error('Empty scope not allowed');

    // NOTE: this function intentionally does not allow '*'. This is only allowed in the db to allow
    // us not write a migration script every time we add a new scope
    var allValid = scope.split(',').every(function (s) { return exports.VALID_SCOPES.indexOf(s.split(':')[0]) !== -1; });
    if (!allValid) return new Error('Invalid scope. Available scopes are ' + exports.VALID_SCOPES.join(', '));

    return null;
}

// tests if all requiredScopes are attached to the request
function hasScopes(authorizedScopes, requiredScopes) {
    assert(Array.isArray(authorizedScopes), 'Expecting array');
    assert(Array.isArray(requiredScopes), 'Expecting array');

    if (authorizedScopes.indexOf(exports.SCOPE_ANY) !== -1) return null;

    for (var i = 0; i < requiredScopes.length; ++i) {
        const scopeParts = requiredScopes[i].split(':');

        // this allows apps:write if the token has a higher apps scope
        if (authorizedScopes.indexOf(requiredScopes[i]) === -1 && authorizedScopes.indexOf(scopeParts[0]) === -1) {
            debug('scope: missing scope "%s".', requiredScopes[i]);
            return new Error('Missing required scope "' + requiredScopes[i] + '"');
        }
    }

    return null;
}

function scopesForUser(user) {
    return users.isAdmin(user) ? exports.VALID_SCOPES : [ 'profile', 'apps:read' ];
}

function validateToken(accessToken, callback) {
    assert.strictEqual(typeof accessToken, 'string');
    assert.strictEqual(typeof callback, 'function');

    tokendb.get(accessToken, function (error, token) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, null /* user */, 'Invalid Token'); // will end up as a 401
        if (error) return callback(error); // this triggers 'internal error' in passport

        users.get(token.identifier, function (error, user) {
            if (error && error.reason === UsersError.NOT_FOUND) return callback(null, null /* user */, 'Invalid Token'); // will end up as a 401
            if (error) return callback(error);

            const userScopes = scopesForUser(user);
            var authorizedScopes = intersectScopes(userScopes, token.scope.split(','));
            const skipPasswordVerification = token.clientId === 'cid-sdk' || token.clientId === 'cid-cli'; // these clients do not require password checks unlike UI
            var info = { authorizedScopes: authorizedScopes, skipPasswordVerification: skipPasswordVerification }; // ends up in req.authInfo

            callback(null, user, info);
        });
    });
}
