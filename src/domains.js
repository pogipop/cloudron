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
    subdomains = require('./subdomains.js'),
    SubdomainError = subdomains.SubdomainError,
    sysinfo = require('./sysinfo.js'),
    tld = require('tldjs'),
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

function add(domain, zoneName, config, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!tld.isValid(domain)) return callback(new DomainError(DomainError.BAD_FIELD, 'Invalid domain'));
    if (!tld.isValid(zoneName)) return callback(new DomainError(DomainError.BAD_FIELD, 'Invalid zoneName'));

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, 'Error getting IP:' + error.message));

        subdomains.verifyDnsConfig(config, domain, zoneName, ip, function (error, result) {
            if (error && error.reason === SubdomainError.ACCESS_DENIED) return callback(new DomainError(DomainError.BAD_FIELD, 'Error adding A record. Access denied'));
            if (error && error.reason === SubdomainError.NOT_FOUND) return callback(new DomainError(DomainError.BAD_FIELD, 'Zone not found'));
            if (error && error.reason === SubdomainError.EXTERNAL_ERROR) return callback(new DomainError(DomainError.BAD_FIELD, 'Error adding A record:' + error.message));
            if (error && error.reason === SubdomainError.BAD_FIELD) return callback(new DomainError(DomainError.BAD_FIELD, error.message));
            if (error && error.reason === SubdomainError.INVALID_PROVIDER) return callback(new DomainError(DomainError.BAD_FIELD, error.message));
            if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

            domaindb.add(domain, zoneName, result, function (error) {
                if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new DomainError(DomainError.ALREADY_EXISTS));
                if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

                return callback(null);
            });
        });
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

    domaindb.get(domain, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainError(DomainError.NOT_FOUND));
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        sysinfo.getPublicIp(function (error, ip) {
            if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, 'Error getting IP:' + error.message));

            subdomains.verifyDnsConfig(config, domain, result.zoneName, ip, function (error, result) {
                if (error && error.reason === SubdomainError.ACCESS_DENIED) return callback(new DomainError(DomainError.BAD_FIELD, 'Error adding A record. Access denied'));
                if (error && error.reason === SubdomainError.NOT_FOUND) return callback(new DomainError(DomainError.BAD_FIELD, 'Zone not found'));
                if (error && error.reason === SubdomainError.EXTERNAL_ERROR) return callback(new DomainError(DomainError.BAD_FIELD, 'Error adding A record:' + error.message));
                if (error && error.reason === SubdomainError.BAD_FIELD) return callback(new DomainError(DomainError.BAD_FIELD, error.message));
                if (error && error.reason === SubdomainError.INVALID_PROVIDER) return callback(new DomainError(DomainError.BAD_FIELD, error.message));
                if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

                domaindb.update(domain, result, function (error) {
                    if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainError(DomainError.NOT_FOUND));
                    if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

                    return callback(null);
                });
            });
        });
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
