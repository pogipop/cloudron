'use strict';

exports = module.exports = {
    removePrivateFields: removePrivateFields,
    injectPrivateFields: injectPrivateFields,
    upsert: upsert,
    get: get,
    del: del,
    wait: wait,
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    debug = require('debug')('box:dns/manual'),
    dns = require('../native-dns.js'),
    domains = require('../domains.js'),
    DomainsError = require('../domains.js').DomainsError,
    sysinfo = require('../sysinfo.js'),
    util = require('util'),
    waitForDns = require('./waitfordns.js');

function removePrivateFields(domainObject) {
    return domainObject;
}

function injectPrivateFields(newConfig, currentConfig) {
}

function upsert(domainObject, location, type, values, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug('upsert: %s for zone %s of type %s with values %j', location, domainObject.zoneName, type, values);

    return callback(null);
}

function get(domainObject, location, type, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback(null, [ ]); // returning ip confuses apptask into thinking the entry already exists
}

function del(domainObject, location, type, values, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    return callback();
}

function wait(domainObject, location, type, value, options, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof value, 'string');
    assert(options && typeof options === 'object'); // { interval: 5000, times: 50000 }
    assert.strictEqual(typeof callback, 'function');

    const fqdn = domains.fqdn(location, domainObject);

    waitForDns(fqdn, domainObject.zoneName, type, value, options, callback);
}

function verifyDnsConfig(domainObject, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof callback, 'function');

    const zoneName = domainObject.zoneName;

    // Very basic check if the nameservers can be fetched
    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        const location = 'cloudrontestdns';
        const fqdn = domains.fqdn(location, domainObject);

        dns.resolve(fqdn, 'A', { server: '127.0.0.1', timeout: 5000 }, function (error, result) {
            if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, `Unable to resolve ${fqdn}`));
            if (error || !result) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : `Unable to resolve ${fqdn}`));

            sysinfo.getPublicIp(function (error, ip) {
                if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, `Failed to detect IP of this server: ${error.message}`));

                if (result.length !== 1 || ip !== result[0]) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, `Domain resolves to ${JSON.stringify(result)} instead of ${ip}`));

                callback(null, {});
            });
        });
    });
}
