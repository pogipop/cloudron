'use strict';

exports = module.exports = {
    upsert: upsert,
    get: get,
    del: del,
    waitForDns: require('./waitfordns.js'),
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    debug = require('debug')('box:dns/manual'),
    dns = require('../native-dns.js'),
    DomainsError = require('../domains.js').DomainsError,
    sysinfo = require('../sysinfo.js'),
    util = require('util');

function upsert(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug('upsert: %s for zone %s of type %s with values %j', subdomain, zoneName, type, values);

    return callback(null);
}

function get(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback(null, [ ]); // returning ip confuses apptask into thinking the entry already exists
}

function del(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    return callback();
}

function verifyDnsConfig(dnsConfig, domain, zoneName, ip, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Very basic check if the nameservers can be fetched
    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        const separator = dnsConfig.hyphenatedSubdomains ? '-' : '.';
        const fqdn = `cloudrontest${separator}${domain}`;
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