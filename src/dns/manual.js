'use strict';

exports = module.exports = {
    upsert: upsert,
    get: get,
    del: del,
    waitForDns: require('./waitfordns.js'),
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    async = require('async'),
    config = require('../config.js'),
    debug = require('debug')('box:dns/manual'),
    dig = require('../dig.js'),
    dns = require('dns'),
    SubdomainError = require('../subdomains.js').SubdomainError,
    util = require('util');

function upsert(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug('upsert: %s for zone %s of type %s with values %j', subdomain, zoneName, type, values);

    return callback(null, 'noop-record-id');
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

    var adminDomain = config.adminLocation() + '.' + domain;

    dns.resolveNs(zoneName, function (error, nameservers) {
        if (error || !nameservers) return callback(new SubdomainError(SubdomainError.BAD_FIELD, 'Unable to get nameservers'));

        async.every(nameservers, function (nameserver, everyNsCallback) {
            // ns records cannot have cname
            dns.resolve4(nameserver, function (error, nsIps) {
                if (error || !nsIps || nsIps.length === 0) {
                    return everyNsCallback(new SubdomainError(SubdomainError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
                }

                async.every(nsIps, function (nsIp, everyIpCallback) {
                    dig.resolve(adminDomain, 'A', { server: nsIp, timeout: 5000 }, function (error, answer) {
                        if (error && error.code === 'ETIMEDOUT') {
                            debug('nameserver %s (%s) timed out when trying to resolve %s', nameserver, nsIp, adminDomain);
                            return everyIpCallback(null, true); // should be ok if dns server is down
                        }

                        if (error) {
                            debug('nameserver %s (%s) returned error trying to resolve %s: %s', nameserver, nsIp, adminDomain, error);
                            return everyIpCallback(null, false);
                        }

                        if (!answer || answer.length === 0) {
                            debug('bad answer from nameserver %s (%s) resolving %s (%s): %j', nameserver, nsIp, adminDomain, 'A', answer);
                            return everyIpCallback(null, false);
                        }

                        debug('verifyDnsConfig: ns: %s (%s), name:%s Actual:%j Expecting:%s', nameserver, nsIp, adminDomain, answer, ip);

                        var match = answer.some(function (a) { return a === ip; });

                        if (match) return everyIpCallback(null, true); // done!

                        everyIpCallback(null, false);
                    });
                }, everyNsCallback);
            });
        }, function (error, success) {
            if (error) return callback(error);
            if (!success) return callback(new SubdomainError(SubdomainError.BAD_FIELD, 'The domain ' + adminDomain + ' does not resolve to the server\'s IP ' + ip));

            callback(null, { provider: dnsConfig.provider, wildcard: !!dnsConfig.wildcard });
        });
    });
}
