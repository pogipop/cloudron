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

    validateScope: validateScope,
    validateRequestedScopes: validateRequestedScopes,
    normalizeScope: normalizeScope,
    canonicalScope: canonicalScope
};

var assert = require('assert'),
    debug = require('debug')('box:accesscontrol'),
    _ = require('underscore');

function validateScope(scope) {
    assert.strictEqual(typeof scope, 'string');

    if (scope === '') return new Error('Empty scope not allowed');

    var allValid = scope.split(',').every(function (s) { return exports.VALID_SCOPES.indexOf(s) !== -1; });
    if (!allValid) return new Error('Invalid scope. Available scopes are ' + exports.VALID_SCOPES.join(', '));

    return null;
}

// tests if all requestedScopes are attached to the request
function validateRequestedScopes(authInfo, requestedScopes) {
    assert.strictEqual(typeof authInfo, 'object');
    assert(Array.isArray(requestedScopes));

    if (!authInfo || !authInfo.scope) return new Error('No scope found');

    var scopes = authInfo.scope.split(',');

    if (scopes.indexOf(exports.SCOPE_ANY) !== -1) return null;

    for (var i = 0; i < requestedScopes.length; ++i) {
        if (scopes.indexOf(requestedScopes[i]) === -1) {
            debug('scope: missing scope "%s".', requestedScopes[i]);
            return new Error('Missing required scope "' + requestedScopes[i] + '"');
        }
    }

    return null;
}

function normalizeScope(allowedScope, wantedScope) {
    assert.strictEqual(typeof allowedScope, 'string');
    assert.strictEqual(typeof wantedScope, 'string');

    const allowedScopes = allowedScope.split(',');
    const wantedScopes = wantedScope.split(',');

    if (allowedScopes.indexOf(exports.SCOPE_ANY) !== -1) return wantedScope;
    if (wantedScopes.indexOf(exports.SCOPE_ANY) !== -1) return allowedScope;

    return _.intersection(allowedScopes, wantedScopes).join(',');
}

function canonicalScope(scope) {
    return scope.replace(exports.SCOPE_ANY, exports.VALID_SCOPES.join(','));
}
