'use strict';

exports = module.exports = {
    // keep this in sync with start.sh ADMIN_SCOPES that generates the cid-webadmin
    SCOPE_APPS: 'apps',
    SCOPE_DEVELOPER: 'developer', // obsolete
    SCOPE_PROFILE: 'profile',
    SCOPE_CLOUDRON: 'cloudron',
    SCOPE_SETTINGS: 'settings',
    SCOPE_USERS: 'users',
    SCOPE_MAIL: 'mail',
    SCOPE_CLIENTS: 'clients',
    SCOPE_DOMAINS: 'domains',

    // roles are handled just like the above scopes, they are parallel to scopes
    // scopes enclose API groups, roles specify the usage role
    SCOPE_ROLE_SDK: 'roleSdk',

    validateScope: validateScope,
    validateRequestedScopes: validateRequestedScopes,
    normalizeScope: normalizeScope
};

var assert = require('assert'),
    debug = require('debug')('box:accesscontrol'),
    _ = require('underscore');

function validateScope(scope) {
    assert.strictEqual(typeof scope, 'string');

    var VALID_SCOPES = [
        exports.SCOPE_APPS,
        exports.SCOPE_DEVELOPER,
        exports.SCOPE_PROFILE,
        exports.SCOPE_CLOUDRON,
        exports.SCOPE_SETTINGS,
        exports.SCOPE_USERS,
        exports.SCOPE_DOMAIN,
        exports.SCOPE_CLIENTS,
        exports.SCOPE_MAIL,
        '*',    // includes all scopes, but not roles
        exports.SCOPE_ROLE_SDK
    ];

    if (scope === '') return new Error('Empty scope not allowed');

    var allValid = scope.split(',').every(function (s) { return VALID_SCOPES.indexOf(s) !== -1; });
    if (!allValid) return new Error('Invalid scope. Available scopes are ' + VALID_SCOPES.join(', '));

    return null;
}

// tests if all requestedScopes are attached to the request
function validateRequestedScopes(authInfo, requestedScopes) {
    assert.strictEqual(typeof authInfo, 'object');
    assert(Array.isArray(requestedScopes));

    if (!authInfo || !authInfo.scope) return new Error('No scope found');

    var scopes = authInfo.scope.split(',');

    // check for roles separately
    if (requestedScopes.indexOf(exports.SCOPE_ROLE_SDK) !== -1 && scopes.indexOf(exports.SCOPE_ROLE_SDK) === -1) {
        return new Error('Missing required scope role "' + exports.SCOPE_ROLE_SDK + '"');
    }

    if (scopes.indexOf('*') !== -1) return null;

    for (var i = 0; i < requestedScopes.length; ++i) {
        if (scopes.indexOf(requestedScopes[i]) === -1) {
            debug('scope: missing scope "%s".', requestedScopes[i]);
            return new Error('Missing required scope "' + requestedScopes[i] + '"');
        }
    }

    return null;
}

function normalizeScope(maxScope, allowedScope) {
    assert.strictEqual(typeof maxScope, 'string');
    assert.strictEqual(typeof allowedScope, 'string');

    if (maxScope === '*') return allowedScope;

    return _.intersection(maxScope.split(','), allowedScope.split(',')).join(',');
}
