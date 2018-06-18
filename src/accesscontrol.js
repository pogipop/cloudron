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
    SCOPE_APPSTORE: 'appstore',
    VALID_SCOPES: [ 'apps', 'appstore', 'clients', 'cloudron', 'domains', 'mail', 'profile', 'settings', 'users' ],

    SCOPE_ANY: '*',

    ROLE_OWNER: 'owner',

    validateRoles: validateRoles,

    validateScopeString: validateScopeString,
    hasScopes: hasScopes,
    intersectScopes: intersectScopes,
    canonicalScopeString: canonicalScopeString
};

var assert = require('assert'),
    debug = require('debug')('box:accesscontrol'),
    _ = require('underscore');

function canonicalScopeString(scope) {
    return scope === exports.SCOPE_ANY ? exports.VALID_SCOPES.join(',') : scope;
}

function intersectScopes(allowedScopes, wantedScopes) {
    assert(Array.isArray(allowedScopes), 'Expecting array');
    assert(Array.isArray(wantedScopes), 'Expecting array');

    return _.intersection(allowedScopes, wantedScopes);
}

function validateRoles(roles) {
    assert(Array.isArray(roles));

    if (roles.length === 0) return null;
    if (roles.length === 1 && roles[0] === exports.ROLE_OWNER) return null;

    return new Error('Invalid role');
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
