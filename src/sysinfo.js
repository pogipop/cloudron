'use strict';

exports = module.exports = {
    SysInfoError: SysInfoError,

    getPublicIp: getPublicIp,

    hasIPv6: hasIPv6,
    provider: provider
};

var assert = require('assert'),
    config = require('./config.js'),
    ec2 = require('./sysinfo/ec2.js'),
    fs = require('fs'),
    generic = require('./sysinfo/generic.js'),
    paths = require('./paths.js'),
    scaleway = require('./sysinfo/scaleway.js'),
    safe = require('safetydance'),
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

let gProvider = null;


function provider() {
    if (gProvider) return gProvider;

    gProvider = safe.fs.readFileSync(paths.PROVIDER_FILE, 'utf8');
    if (!gProvider) return gProvider = 'generic';

    return gProvider;
}

function getApi(callback) {
    assert.strictEqual(typeof callback, 'function');

    switch (provider()) {
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

function hasIPv6() {
    const IPV6_PROC_FILE = '/proc/net/if_inet6';
    // on contabo, /proc/net/if_inet6 is an empty file. so just exists is not enough
    return fs.existsSync(IPV6_PROC_FILE) && fs.readFileSync(IPV6_PROC_FILE, 'utf8').trim().length !== 0;
}
