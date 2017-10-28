'use strict';

module.exports = exports = {
    add: add,
    get: get,
    getAll: getAll,
    update: update,
    del: del,

    DomainError: DomainError
};

var assert = require('assert'),
    DatabaseError = require('./databaseerror.js'),
    domaindb = require('./domaindb.js'),
    util = require('util');

function DomainError(reason, errorOrMessage) {
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
util.inherits(DomainError, Error);

DomainError.NOT_FOUND = 'No such domain';
DomainError.ALREADY_EXISTS = 'Domain already exists';
DomainError.EXTERNAL_ERROR = 'External error';
DomainError.BAD_FIELD = 'Bad Field';
DomainError.STILL_BUSY = 'Still busy';
DomainError.INTERNAL_ERROR = 'Internal error';
DomainError.ACCESS_DENIED = 'Access denied';
DomainError.INVALID_PROVIDER = 'provider must be route53, gcdns, digitalocean, cloudflare, noop, manual or caas';

function add(domain, config, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof callback, 'function');

    // TODO validate domain and config

    domaindb.add(domain, config, function (error) {
        if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new DomainError(DomainError.ALREADY_EXISTS));
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function get(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    domaindb.get(domain, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainError(DomainError.NOT_FOUND));
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    domaindb.getAll(function (error, result) {
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function update(domain, config, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof callback, 'function');

    // TODO validate config

    domaindb.update(domain, config, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainError(DomainError.NOT_FOUND));
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function del(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    // TODO check if domain is still used by an app

    domaindb.del(domain, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainError(DomainError.NOT_FOUND));
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        return callback(null);
    });
}
