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
    fs = require('fs'),
    path = require('path'),
    safe = require('safetydance'),
    util = require('util');

var AUTHORIZED_KEYS_FILEPATH = config.TEST ? path.join(config.baseDir(), 'authorized_keys') : '/root/.ssh/authorized_keys';
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
    fs.unlink(AUTHORIZED_KEYS_FILEPATH, function (error) {
        if (error && error.code !== 'ENOENT') return callback(error);
        callback();
    });
}

function getKeys() {
    var content = safe.fs.readFileSync(AUTHORIZED_KEYS_FILEPATH, 'utf8');
    if (!content) return [];

    var keys = content.split('\n')
        .filter(function (k) { return !!k.trim(); })
        .map(function (k) { return { identifier: k.split(' ')[2], key: k }; })
        .filter(function (k) { return k.identifier && k.key; });

    return keys;
}

function getAuthorizedKeys(callback) {
    assert.strictEqual(typeof callback, 'function');

    return callback(null, getKeys().sort(function (a, b) { return a.identifier.localeCompare(b.identifier); }));
}

function getAuthorizedKey(identifier, callback) {
    assert.strictEqual(typeof identifier, 'string');
    assert.strictEqual(typeof callback, 'function');

    var keys = getKeys();
    if (keys.length === 0) return callback(new SshError(SshError.NOT_FOUND));

    var key = keys.find(function (k) { return k.identifier === identifier; });
    if (!key) return callback(new SshError(SshError.NOT_FOUND));

    callback(null, key);
}

function addAuthorizedKey(key, callback) {
    assert.strictEqual(typeof key, 'string');
    assert.strictEqual(typeof callback, 'function');

    var tmp = key.split(' ');
    if (tmp.length !== 3) return callback(new SshError(SshError.INVALID_KEY));
    if (!VALID_KEY_TYPES.some(function (t) { return tmp[0] === t; })) return callback(new SshError(SshError.INVALID_KEY, 'Invalid key type'));
    if (tmp[1].length < VALID_MIN_KEY_LENGTH) return callback(new SshError(SshError.INVALID_KEY));

    var identifier = tmp[2];

    var keys = getKeys();
    var index = keys.findIndex(function (k) { return k.identifier === identifier; });
    if (index !== -1) keys[index] = { identifier: identifier, key: key };
    else keys.push({ identifier: identifier, key: key });

    if (!safe.fs.writeFileSync(AUTHORIZED_KEYS_FILEPATH, keys.map(function (k) { return k.key; }).join('\n'))) {
        console.error(safe.error);
        return callback(new SshError(SshError.INTERNAL_ERROR, safe.error));
    }

    callback();
}

function delAuthorizedKey(identifier, callback) {
    assert.strictEqual(typeof identifier, 'string');
    assert.strictEqual(typeof callback, 'function');

    var keys = getKeys();
    var index = keys.findIndex(function (k) { return k.identifier === identifier; });
    if (index === -1) return callback(new SshError(SshError.NOT_FOUND));

    // now remove the key
    keys.splice(index, 1);

    if (!safe.fs.writeFileSync(AUTHORIZED_KEYS_FILEPATH, keys.map(function (k) { return k.key; }).join('\n'))) {
        console.error(safe.error);
        return callback(new SshError(SshError.INTERNAL_ERROR, safe.error));
    }

    callback();
}
