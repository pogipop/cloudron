'use strict';

exports = module.exports = {
    upsert: upsert,
    get: get,
    del: del,
    waitForDns: require('./waitfordns.js'),
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    debug = require('debug')('box:dns/gandi'),
    dns = require('../native-dns.js'),
    DomainsError = require('../domains.js').DomainsError,
    superagent = require('superagent'),
    util = require('util');

var GANDI_API = 'https://dns.api.gandi.net/api/v5';

function formatError(response) {
    return util.format('Gandi DNS error [%s] %j', response.statusCode, response.body);
}

function upsert(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    subdomain = subdomain || '@';

    debug(`upsert: ${subdomain} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    var data = {
        'rrset_ttl': 300, // this is the minimum allowed
        'rrset_values': values
    };

    superagent.put(`${GANDI_API}/domains/${zoneName}/records/${subdomain}/${type}`)
        .set('X-Api-Key', dnsConfig.token)
        .timeout(30 * 1000)
        .send(data)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode !== 201) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

            return callback(null, 'unused-id');
        });
}

function get(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    subdomain = subdomain || '@';

    debug(`get: ${subdomain} in zone ${zoneName} of type ${type}`);

    superagent.get(`${GANDI_API}/domains/${zoneName}/records/${subdomain}/${type}`)
        .set('X-Api-Key', dnsConfig.token)
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 404) return callback(new DomainsError(DomainsError.NOT_FOUND, formatError(result)));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

            debug('get: %j', result.body);

            return callback(null, result.body.rrset_values);
        });
}

function del(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    subdomain = subdomain || '@';

    debug(`get: ${subdomain} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    superagent.del(`${GANDI_API}/domains/${zoneName}/records/${subdomain}/${type}`)
        .set('X-Api-Key', dnsConfig.token)
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 404) return callback(null);
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode !== 204) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

            debug('del: done');

            return callback(null);
        });
}

function verifyDnsConfig(dnsConfig, fqdn, zoneName, ip, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    var credentials = {
        token: dnsConfig.token
    };

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        if (!nameservers.every(function (n) { return n.toLowerCase().indexOf('.gandi.net') !== -1; })) {
            debug('verifyDnsConfig: %j does not contain Gandi NS', nameservers);
            return callback(new DomainsError(DomainsError.BAD_FIELD, 'Domain nameservers are not set to Gandi'));
        }

        const testSubdomain = 'cloudrontestdns';

        upsert(credentials, zoneName, testSubdomain, 'A', [ ip ], function (error, changeId) {
            if (error) return callback(error);

            debug('verifyDnsConfig: Test A record added with change id %s', changeId);

            del(dnsConfig, zoneName, testSubdomain, 'A', [ ip ], function (error) {
                if (error) return callback(error);

                debug('verifyDnsConfig: Test A record removed again');

                callback(null, credentials);
            });
        });
    });
}
