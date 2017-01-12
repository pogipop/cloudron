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
    debug = require('debug')('box:dns/noop'),
    dns = require('native-dns'),
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

function verifyDnsConfig(dnsConfig, domain, ip, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    var adminDomain = 'my.' + domain;

    dns.resolveNs(domain, function (error, nameservers) {
        if (error || !nameservers) return callback(new SubdomainError(SubdomainError.BAD_FIELD, 'Unable to get nameservers'));

        // async.every only reports bools
        var stashedError = null;

        async.every(nameservers, function (nameserver, callback) {
            // ns records cannot have cname
            dns.resolve4(nameserver, function (error, nsIps) {
                if (error || !nsIps || nsIps.length === 0) {
                    stashedError = new SubdomainError(SubdomainError.BAD_FIELD, 'Unable to resolve nameservers for this domain');
                    return callback(false);
                }

                async.every(nsIps, function (nsIp, callback) {
                    var req = dns.Request({
                        question: dns.Question({ name: adminDomain, type: 'A' }),
                        server: { address: nsIp },
                        timeout: 5000
                    });

                    req.on('timeout', function () {
                        debug('nameserver %s (%s) timed out when trying to resolve %s', nameserver, nsIp, adminDomain);
                        return callback(true); // should be ok if dns server is down
                    });

                    req.on('message', function (error, message) {
                        if (error) {
                            debug('nameserver %s (%s) returned error trying to resolve %s: %s', nameserver, nsIp, adminDomain, error);
                            return callback(false);
                        }

                        var answer = message.answer;

                        if (!answer || answer.length === 0) {
                            debug('bad answer from nameserver %s (%s) resolving %s (%s): %j', nameserver, nsIp, adminDomain, 'A', message);
                            return callback(false);
                        }

                        debug('verifyDnsConfig: ns: %s (%s), name:%s Actual:%j Expecting:%s', nameserver, nsIp, adminDomain, answer, ip);

                        var match = answer.some(function (a) {
                            return a.address === ip;
                        });

                        if (match) return callback(true); // done!

                        callback(false);
                    });

                    req.send();
                }, callback);
            });
        }, function (success) {
            if (stashedError) return callback(stashedError);
            if (!success) return callback(new SubdomainError(SubdomainError.BAD_FIELD, 'The domain ' + adminDomain + ' does not resolve to the server\'s IP ' + ip));

            callback(null, { provider: dnsConfig.provider, wildcard: !!dnsConfig.wildcard });
        });
    });
}
