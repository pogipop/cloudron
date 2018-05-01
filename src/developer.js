/* jslint node: true */

'use strict';

exports = module.exports = {
    DeveloperError: DeveloperError,

    issueDeveloperToken: issueDeveloperToken
};

var accesscontrol = require('./accesscontrol.js'),
    assert = require('assert'),
    constants = require('./constants.js'),
    eventlog = require('./eventlog.js'),
    tokendb = require('./tokendb.js'),
    users = require('./users.js'),
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

    tokendb.add(token, userObject.id, 'cid-cli', expiresAt, accesscontrol.SCOPE_ANY, function (error) {
        if (error) return callback(new DeveloperError(DeveloperError.INTERNAL_ERROR, error));

        eventlog.add(eventlog.ACTION_USER_LOGIN, { authType: 'cli', ip: ip }, { userId: userObject.id, user: users.removePrivateFields(userObject) });

        callback(null, { token: token, expiresAt: new Date(expiresAt).toISOString() });
    });
}
