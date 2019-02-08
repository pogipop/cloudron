'use strict';

// -------------------------------------------
//  This file just describes the interface
//
//  New backends can start from here
// -------------------------------------------

exports = module.exports = {
    removePrivateFields: removePrivateFields,
    upsert: upsert,
    get: get,
    del: del,
    wait: wait,
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    util = require('util');

function removePrivateFields(domainObject) {
    // in-place removal of tokens and api keys with domains.SECRET_PLACEHOLDER
    return domainObject;
}

function upsert(domainObject, location, type, values, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function get(domainObject, location, type, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: Array of matching DNS records in string format

    callback(new Error('not implemented'));
}

function del(domainObject, location, type, values, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    // Result: none

    callback(new Error('not implemented'));
}

function wait(domainObject, location, type, value, options, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof value, 'string');
    assert(options && typeof options === 'object'); // { interval: 5000, times: 50000 }
    assert.strictEqual(typeof callback, 'function');

    callback();
}

function verifyDnsConfig(domainObject, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof callback, 'function');

    // Result: dnsConfig object

    callback(new Error('not implemented'));
}
