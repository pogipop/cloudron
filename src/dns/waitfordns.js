'use strict';

exports = module.exports = waitForDns;

var assert = require('assert'),
    async = require('async'),
    debug = require('debug')('box:dns/waitfordns'),
    dns = require('../native-dns.js'),
    DomainError = require('../domains.js').DomainError;

function isChangeSynced(domain, value, nameserver, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof value, 'string');
    assert.strictEqual(typeof nameserver, 'string');
    assert.strictEqual(typeof callback, 'function');

    // ns records cannot have cname
    dns.resolve4(nameserver, function (error, nsIps) {
        if (error || !nsIps || nsIps.length === 0) {
            debug('nameserver %s does not resolve. assuming it stays bad.', nameserver); // it's fine if one or more ns are dead
            return callback(null, true);
        }

        async.every(nsIps, function (nsIp, iteratorCallback) {
            dns.resolve(domain, 'A', { server: nsIp, timeout: 5000 }, function (error, answer) {
                if (error && error.code === 'TIMEOUT') {
                    debug('nameserver %s (%s) timed out when trying to resolve %s', nameserver, nsIp, domain);
                    return iteratorCallback(null, true); // should be ok if dns server is down
                }

                if (error) {
                    debug('nameserver %s (%s) returned error trying to resolve %s: %s', nameserver, nsIp, domain, error);
                    return iteratorCallback(null, false);
                }

                if (!answer || answer.length === 0) {
                    debug('bad answer from nameserver %s (%s) resolving %s', nameserver, nsIp, domain);
                    return iteratorCallback(null, false);
                }

                debug('isChangeSynced: ns: %s (%s), name:%s Actual:%j Expecting:%s', nameserver, nsIp, domain, answer, value);

                var match = answer.some(a => a === value);

                if (match) return iteratorCallback(null, true); // done!

                iteratorCallback(null, false);
            });
        }, callback);

    });
}

// check if IP change has propagated to every nameserver
function waitForDns(domain, zoneName, value, options, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof value, 'string');
    assert(options && typeof options === 'object'); // { interval: 5000, times: 50000 }
    assert.strictEqual(typeof callback, 'function');

    debug('waitForIp: domain %s to be %s in zone %s.', domain, value, zoneName);

    var attempt = 1;
    async.retry(options, function (retryCallback) {
        debug('waitForDNS: %s (zone: %s) attempt %s.', domain, zoneName, attempt++);

        dns.resolveNs(zoneName, function (error, nameservers) {
            if (error || !nameservers) return retryCallback(error || new DomainError(DomainError.EXTERNAL_ERROR, 'Unable to get nameservers'));

            async.every(nameservers, isChangeSynced.bind(null, domain, value), function (error, synced) {
                debug('waitForIp: %s %s ns: %j', domain, synced ? 'done' : 'not done', nameservers);

                retryCallback(synced ? null : new DomainError(DomainError.EXTERNAL_ERROR, 'ETRYAGAIN'));
            });
        });
    }, function retryDone(error) {
        if (error) return callback(error);

        debug('waitForDNS: %s done.', domain);

        callback(null);
    });
}
