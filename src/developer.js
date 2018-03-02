/* jslint node: true */

'use strict';

exports = module.exports = {
    DeveloperError: DeveloperError,

    issueDeveloperToken: issueDeveloperToken
};

var assert = require('assert'),
    clients = require('./clients.js'),
    constants = require('./constants.js'),
    eventlog = require('./eventlog.js'),
    tokendb = require('./tokendb.js'),
    user = require('./user.js'),
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

function issueDeveloperToken(userObject, ip, callback) {
    assert.strictEqual(typeof userObject, 'object');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    var token = tokendb.generateToken();
    var expiresAt = Date.now() + constants.DEFAULT_TOKEN_EXPIRATION;
    var scopes = '*,' + clients.SCOPE_ROLE_SDK;

    tokendb.add(token, userObject.id, 'cid-cli', expiresAt, scopes, function (error) {
        if (error) return callback(new DeveloperError(DeveloperError.INTERNAL_ERROR, error));

        eventlog.add(eventlog.ACTION_USER_LOGIN, { authType: 'cli', ip: ip }, { userId: userObject.id, user: user.removePrivateFields(userObject) });

        callback(null, { token: token, expiresAt: new Date(expiresAt).toISOString() });
    });
}
