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

    validateRoles: validateRoles,

    validateScope: validateScope,
    hasScopes: hasScopes,
    intersectScope: intersectScope,
    canonicalScope: canonicalScope
};

var assert = require('assert'),
    debug = require('debug')('box:accesscontrol'),
    _ = require('underscore');

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
