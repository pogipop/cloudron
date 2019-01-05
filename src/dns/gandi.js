'use strict';

exports = module.exports = {
    upsert: upsert,
    get: get,
    del: del,
    wait: wait,
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    debug = require('debug')('box:dns/gandi'),
    dns = require('../native-dns.js'),
    domains = require('../domains.js'),
    DomainsError = require('../domains.js').DomainsError,
    superagent = require('superagent'),
    util = require('util'),
    waitForDns = require('./waitfordns.js');

var GANDI_API = 'https://dns.api.gandi.net/api/v5';

function formatError(response) {
    return util.format(`Gandi DNS error [${response.statusCode}] ${response.body.message}`);
}

function upsert(domainObject, location, type, values, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    const dnsConfig = domainObject.config,
        zoneName = domainObject.zoneName,
        name = domains.getName(domainObject, location, type) || '@';

    debug(`upsert: ${name} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    var data = {
        'rrset_ttl': 300, // this is the minimum allowed
        'rrset_values': values // for mx records, value is already of the '<priority> <server>' format
    };

    superagent.put(`${GANDI_API}/domains/${zoneName}/records/${name}/${type}`)
        .set('X-Api-Key', dnsConfig.token)
        .timeout(30 * 1000)
        .send(data)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode === 400) return callback(new DomainsError(DomainsError.BAD_FIELD, formatError(result)));
            if (result.statusCode !== 201) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

            return callback(null);
        });
}

function get(domainObject, location, type, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    const dnsConfig = domainObject.config,
        zoneName = domainObject.zoneName,
        name = domains.getName(domainObject, location, type) || '@';

    debug(`get: ${name} in zone ${zoneName} of type ${type}`);

    superagent.get(`${GANDI_API}/domains/${zoneName}/records/${name}/${type}`)
        .set('X-Api-Key', dnsConfig.token)
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode === 404) return callback(null, [ ]);
            if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

            debug('get: %j', result.body);

            return callback(null, result.body.rrset_values);
        });
}

function del(domainObject, location, type, values, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    const dnsConfig = domainObject.config,
        zoneName = domainObject.zoneName,
        name = domains.getName(domainObject, location, type) || '@';

    debug(`del: ${name} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    superagent.del(`${GANDI_API}/domains/${zoneName}/records/${name}/${type}`)
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

    const dnsConfig = domainObject.config,
        zoneName = domainObject.zoneName;

    if (!dnsConfig.token || typeof dnsConfig.token !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'token must be a non-empty string'));

    var credentials = {
        token: dnsConfig.token
    };

    const ip = '127.0.0.1';

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        if (!nameservers.every(function (n) { return n.toLowerCase().indexOf('.gandi.net') !== -1; })) {
            debug('verifyDnsConfig: %j does not contain Gandi NS', nameservers);
            return callback(new DomainsError(DomainsError.BAD_FIELD, 'Domain nameservers are not set to Gandi'));
        }

        const location = 'cloudrontestdns';

        upsert(domainObject, location, 'A', [ ip ], function (error) {
            if (error) return callback(error);

            debug('verifyDnsConfig: Test A record added');

            del(domainObject, location, 'A', [ ip ], function (error) {
                if (error) return callback(error);

                debug('verifyDnsConfig: Test A record removed again');

                callback(null, credentials);
            });
        });
    });
}
