/* jslint node: true */

'use strict';

exports = module.exports = {
    DeveloperError: DeveloperError,

    isEnabled: isEnabled,
    setEnabled: setEnabled,
    issueDeveloperToken: issueDeveloperToken
};

var assert = require('assert'),
    clients = require('./clients.js'),
    constants = require('./constants.js'),
    eventlog = require('./eventlog.js'),
    tokendb = require('./tokendb.js'),
    settings = require('./settings.js'),
    util = require('util');

function DeveloperError(reason, errorOrMessage) {
    assert.strictEqual(typeof reason, 'string');
    assert(errorOrMessage instanceof Error || typeof errorOrMessage === 'string' || typeof errorOrMessage === 'undefined');

    Error.call(this);
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name;
    this.reason = reason;
    if (typeof errorOrMessage === 'undefined') {
        this.message = reason;
    } else if (typeof errorOrMessage === 'string') {
        this.message = errorOrMessage;
    } else {
        this.message = 'Internal error';
        this.nestedError = errorOrMessage;
    }
}
util.inherits(DeveloperError, Error);
DeveloperError.INTERNAL_ERROR = 'Internal Error';
DeveloperError.EXTERNAL_ERROR = 'External Error';

function isEnabled(callback) {
    assert.strictEqual(typeof callback, 'function');

    settings.getDeveloperMode(function (error, enabled) {
        if (error) return callback(new DeveloperError(DeveloperError.INTERNAL_ERROR, error));
        callback(null, enabled);
    });
}

function setEnabled(enabled, auditSource, callback) {
    assert.strictEqual(typeof enabled, 'boolean');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    settings.setDeveloperMode(enabled, function (error) {
        if (error) return callback(new DeveloperError(DeveloperError.INTERNAL_ERROR, error));

        eventlog.add(eventlog.ACTION_CLI_MODE, auditSource, { enabled: enabled });

        callback(null);
    });
}

function issueDeveloperToken(user, auditSource, callback) {
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    var token = tokendb.generateToken();
    var expiresAt = Date.now() + constants.DEFAULT_TOKEN_EXPIRATION;
    var scopes = '*,' + clients.SCOPE_ROLE_SDK;

    tokendb.add(token, user.id, 'cid-cli', expiresAt, scopes, function (error) {
        if (error) return callback(new DeveloperError(DeveloperError.INTERNAL_ERROR, error));

        eventlog.add(eventlog.ACTION_USER_LOGIN, auditSource, { authType: 'cli', userId: user.id, username: user.username });

        callback(null, { token: token, expiresAt: new Date(expiresAt).toISOString() });
    });
}
