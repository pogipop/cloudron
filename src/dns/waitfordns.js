'use strict';

exports = module.exports = waitForDns;

var assert = require('assert'),
    async = require('async'),
    debug = require('debug')('box:dns/waitfordns'),
    dns = require('../native-dns.js'),
    DomainsError = require('../domains.js').DomainsError;

function resolveIp(hostname, options, callback) {
    assert.strictEqual(typeof hostname, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    // try A record at authoritative server
    debug(`resolveIp: Checking if ${hostname} has A record at ${options.server}`);
    dns.resolve(hostname, 'A', options, function (error, results) {
        if (!error && results.length !== 0) return callback(null, results);

        // try CNAME record at authoritative server
        debug(`resolveIp: Checking if ${hostname} has CNAME record at ${options.server}`);
        dns.resolve(hostname, 'CNAME', options, function (error, results) {
            if (error || results.length === 0) return callback(error, results);

            // recurse lookup the CNAME record
            debug(`resolveIp: Resolving ${hostname}'s CNAME record ${results[0]}`);
            dns.resolve(results[0], 'A', { server: '127.0.0.1', timeout: options.timeout }, callback);
        });
    });
}

function isChangeSynced(domain, value, nameserver, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof value, 'string');
    assert.strictEqual(typeof nameserver, 'string');
    assert.strictEqual(typeof callback, 'function');

    // ns records cannot have cname
    dns.resolve(nameserver, 'A', { timeout: 5000 }, function (error, nsIps) {
        if (error || !nsIps || nsIps.length === 0) {
            debug(`isChangeSynced: cannot resolve NS ${nameserver}`); // it's fine if one or more ns are dead
            return callback(null, true);
        }

        async.every(nsIps, function (nsIp, iteratorCallback) {
            resolveIp(domain, { server: nsIp, timeout: 5000 }, function (error, answer) {
                if (error && error.code === 'TIMEOUT') {
                    debug(`isChangeSynced: NS ${nameserver} (${nsIp}) timed out when resolving ${domain}`);
                    return iteratorCallback(null, true); // should be ok if dns server is down
                }

                if (error) {
                    debug(`isChangeSynced: NS ${nameserver} (${nsIp}) errored when resolve ${domain}: ${error}`);
                    return iteratorCallback(null, false);
                }

                debug(`isChangeSynced: ${domain} was resolved to ${answer} at NS ${nameserver} (${nsIp}). Expecting ${value}`);

                iteratorCallback(null, answer.length === 1 && answer[0] === value);
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

    debug('waitForDns: domain %s to be %s in zone %s.', domain, value, zoneName);

    var attempt = 0;
    async.retry(options, function (retryCallback) {
        ++attempt;
        debug(`waitForDns (try ${attempt}): ${domain} to be ${value} in zone ${zoneName}`);

        dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
            if (error || !nameservers) return retryCallback(error || new DomainsError(DomainsError.EXTERNAL_ERROR, 'Unable to get nameservers'));

            async.every(nameservers, isChangeSynced.bind(null, domain, value), function (error, synced) {
                debug('waitForDns: %s %s ns: %j', domain, synced ? 'done' : 'not done', nameservers);

                retryCallback(synced ? null : new DomainsError(DomainsError.EXTERNAL_ERROR, 'ETRYAGAIN'));
            });
        });
    }, function retryDone(error) {
        if (error) return callback(error);

        debug(`waitForDns: ${domain} has propagated`);

        callback(null);
    });
}
