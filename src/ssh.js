'use strict';

exports = module.exports = {
    SshError: SshError,

    getAuthorizedKeys: getAuthorizedKeys,
    getAuthorizedKey: getAuthorizedKey,
    addAuthorizedKey: addAuthorizedKey,
    delAuthorizedKey: delAuthorizedKey,

    _clear: clear
};

var assert = require('assert'),
    config = require('./config.js'),
    debug = require('debug')('box:ssh'),
    path = require('path'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    util = require('util');

var AUTHORIZED_KEYS_FILEPATH = config.TEST ? path.join(config.baseDir(), 'authorized_keys') : ((config.provider() === 'ec2' || config.provider() === 'lightsail' || config.provider() === 'ami') ? '/home/ubuntu/.ssh/authorized_keys' : '/root/.ssh/authorized_keys');
var AUTHORIZED_KEYS_TMP_FILEPATH = '/tmp/.authorized_keys';
var AUTHORIZED_KEYS_CMD = path.join(__dirname, 'scripts/authorized_keys.sh');
var VALID_KEY_TYPES = ['ssh-rsa'];  // TODO add all supported ones
var VALID_MIN_KEY_LENGTH = 370;     // TODO verify this length requirement

function SshError(reason, errorOrMessage) {
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
util.inherits(SshError, Error);
SshError.NOT_FOUND = 'Not found';
SshError.INVALID_KEY = 'Invalid key';
SshError.INTERNAL_ERROR = 'Internal Error';

function clear(callback) {
    assert.strictEqual(typeof callback, 'function');

    safe.fs.unlinkSync(AUTHORIZED_KEYS_FILEPATH);
    callback();
}

function saveKeys(keys, callback) {
    assert(Array.isArray(keys));
    assert.strictEqual(typeof callback, 'function');

    if (!safe.fs.writeFileSync(AUTHORIZED_KEYS_TMP_FILEPATH, keys.map(function (k) { return k.key; }).join('\n'))) {
        debug('Error writing to temporary file', safe.error);
        return callback(safe.error);
    }

    if (!safe.fs.chmodSync(AUTHORIZED_KEYS_TMP_FILEPATH, '600')) { // 600 = rw-------
        debug('Failed to adjust permissions of %s %s', AUTHORIZED_KEYS_TMP_FILEPATH, safe.error);
        return callback(safe.error);
    }

    var user = config.TEST ? process.env.USER : ((config.provider() === 'ec2' || config.provider() === 'lightsail' || config.provider() === 'ami') ? 'ubuntu' : 'root');
    shell.sudo('authorized_keys', [ AUTHORIZED_KEYS_CMD, user, AUTHORIZED_KEYS_TMP_FILEPATH, AUTHORIZED_KEYS_FILEPATH ], {}, function (error) {
        if (error) return callback(error);

        callback(null);
    });
}

function getKeys(callback) {
    assert.strictEqual(typeof callback, 'function');

    shell.sudo('authorized_keys', [ AUTHORIZED_KEYS_CMD, process.env.USER, AUTHORIZED_KEYS_FILEPATH, AUTHORIZED_KEYS_TMP_FILEPATH ], {}, function (error) {
        if (error) return callback(error);

        var content = safe.fs.readFileSync(AUTHORIZED_KEYS_TMP_FILEPATH, 'utf8');
        if (!content) return callback(null, []);

        var keys = content.split('\n')
            .filter(function (k) { return !!k.trim(); })
            .map(function (k) { return { identifier: k.split(' ')[2], key: k }; })
            .filter(function (k) { return k.identifier && k.key; });

        safe.fs.unlinkSync(AUTHORIZED_KEYS_TMP_FILEPATH);

        return callback(null, keys);
    });
}

function getAuthorizedKeys(callback) {
    assert.strictEqual(typeof callback, 'function');

    getKeys(function (error, keys) {
        if (error) return callback(new SshError(SshError.INTERNAL_ERROR, error));

        return callback(null, keys.sort(function (a, b) { return a.identifier.localeCompare(b.identifier); }));
    });
}

function getAuthorizedKey(identifier, callback) {
    assert.strictEqual(typeof identifier, 'string');
    assert.strictEqual(typeof callback, 'function');

    getKeys(function (error, keys) {
        if (error) return callback(new SshError(SshError.INTERNAL_ERROR, error));

        if (keys.length === 0) return callback(new SshError(SshError.NOT_FOUND));

        var key = keys.find(function (k) { return k.identifier === identifier; });
        if (!key) return callback(new SshError(SshError.NOT_FOUND));

        callback(null, key);
    });
}

function addAuthorizedKey(key, callback) {
    assert.strictEqual(typeof key, 'string');
    assert.strictEqual(typeof callback, 'function');

    var tmp = key.split(' ');
    if (tmp.length !== 3) return callback(new SshError(SshError.INVALID_KEY));
    if (!VALID_KEY_TYPES.some(function (t) { return tmp[0] === t; })) return callback(new SshError(SshError.INVALID_KEY, 'Invalid key type'));
    if (tmp[1].length < VALID_MIN_KEY_LENGTH) return callback(new SshError(SshError.INVALID_KEY));

    var identifier = tmp[2];

    getKeys(function (error, keys) {
        if (error) return callback(new SshError(SshError.INTERNAL_ERROR, error));

        var index = keys.findIndex(function (k) { return k.identifier === identifier; });
        if (index !== -1) keys[index] = { identifier: identifier, key: key };
        else keys.push({ identifier: identifier, key: key });

        saveKeys(keys, function (error) {
            if (error) return callback(new SshError(SshError.INTERNAL_ERROR, error));

            callback(null);
        });
    });
}

function delAuthorizedKey(identifier, callback) {
    assert.strictEqual(typeof identifier, 'string');
    assert.strictEqual(typeof callback, 'function');

    getKeys(function (error, keys) {
        if (error) return callback(new SshError(SshError.INTERNAL_ERROR, error));

        let index = keys.findIndex(function (k) { return k.identifier === identifier; });
        if (index === -1) return callback(new SshError(SshError.NOT_FOUND));

        // now remove the key
        keys.splice(index, 1);

        saveKeys(keys, function (error) {
            if (error) return callback(new SshError(SshError.INTERNAL_ERROR, error));

            callback(null);
        });
    });
}
