'use strict';

exports = module.exports = {
    getRemoteSupport: getRemoteSupport,
    enableRemoteSupport: enableRemoteSupport,

    SupportError: SupportError
};

let assert = require('assert'),
    constants = require('./constants.js'),
    shell = require('./shell.js'),
    once = require('once'),
    path = require('path'),
    paths = require('./paths.js'),
    sysinfo = require('./sysinfo.js'),
    util = require('util');

// the logic here is also used in the cloudron-support tool
var AUTHORIZED_KEYS_FILEPATH = constants.TEST ? path.join(paths.baseDir(), 'authorized_keys') : ((sysinfo.provider() === 'ec2' || sysinfo.provider() === 'lightsail' || sysinfo.provider() === 'ami') ? '/home/ubuntu/.ssh/authorized_keys' : '/root/.ssh/authorized_keys'),
    AUTHORIZED_KEYS_USER = constants.TEST ? process.getuid() : ((sysinfo.provider() === 'ec2' || sysinfo.provider() === 'lightsail' || sysinfo.provider() === 'ami') ? 'ubuntu' : 'root'),
    AUTHORIZED_KEYS_CMD = path.join(__dirname, 'scripts/remotesupport.sh');

function SupportError(reason, errorOrMessage) {
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
util.inherits(SupportError, Error);
SupportError.NOT_FOUND = 'Not found';
SupportError.INVALID_KEY = 'Invalid key';
SupportError.INTERNAL_ERROR = 'Internal Error';

function getRemoteSupport(callback) {
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback); // exit may or may not be called after an 'error'

    let result = '';
    let cp = shell.sudo('support', [ AUTHORIZED_KEYS_CMD, 'is-enabled', AUTHORIZED_KEYS_FILEPATH ], {}, function (error) {
        if (error) callback(new SupportError(SupportError.INTERNAL_ERROR, error));

        callback(null, { enabled: result.trim() === 'true' });
    });
    cp.stdout.on('data', (data) => result = result + data.toString('utf8'));
}

function enableRemoteSupport(enable, callback) {
    assert.strictEqual(typeof callback, 'function');

    shell.sudo('support', [ AUTHORIZED_KEYS_CMD, enable ? 'enable' : 'disable', AUTHORIZED_KEYS_FILEPATH, AUTHORIZED_KEYS_USER ], {}, function (error) {
        if (error) callback(new SupportError(SupportError.INTERNAL_ERROR, error));

        callback();
    });
}
