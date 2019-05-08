'use strict';

exports = module.exports = {
    SysInfoError: SysInfoError,

    getPublicIp: getPublicIp
};

var assert = require('assert'),
    config = require('./config.js'),
    ec2 = require('./sysinfo/ec2.js'),
    generic = require('./sysinfo/generic.js'),
    scaleway = require('./sysinfo/scaleway.js'),
    util = require('util');

function SysInfoError(reason, errorOrMessage) {
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
util.inherits(SysInfoError, Error);
SysInfoError.INTERNAL_ERROR = 'Internal Error';
SysInfoError.EXTERNAL_ERROR = 'External Error';

function getApi(callback) {
    assert.strictEqual(typeof callback, 'function');

    switch (config.provider()) {
    case 'ec2': return callback(null, ec2);
    case 'lightsail': return callback(null, ec2);
    case 'ami': return callback(null, ec2);
    case 'scaleway': return callback(null, scaleway);
    default: return callback(null, generic);
    }
}

function getPublicIp(callback) {
    assert.strictEqual(typeof callback, 'function');

    getApi(function (error, api) {
        if (error) return callback(error);

        api.getPublicIp(callback);
    });
}
