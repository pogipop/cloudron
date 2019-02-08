'use strict';

exports = module.exports = {
    removePrivateFields: removePrivateFields,
    upsert: upsert,
    get: get,
    del: del,
    wait: wait,
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    config = require('../config.js'),
    debug = require('debug')('box:dns/caas'),
    domains = require('../domains.js'),
    DomainsError = require('../domains.js').DomainsError,
    superagent = require('superagent'),
    util = require('util'),
    waitForDns = require('./waitfordns.js');

function getFqdn(location, domain) {
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domain, 'string');

    return (location === '') ? domain : location + '-' + domain;
}

function removePrivateFields(domainObject) {
    domainObject.config.token = domains.SECRET_PLACEHOLDER;
    return domainObject;
}

function upsert(domainObject, location, type, values, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    const dnsConfig = domainObject.config;

    let fqdn = location !== '' && type === 'TXT' ? location + '.' + domainObject.domain : getFqdn(location, domainObject.domain);

    debug('add: %s for zone %s of type %s with values %j', location, domainObject.domain, type, values);

    var data = {
        type: type,
        values: values
    };

    superagent
        .post(config.apiServerOrigin() + '/api/v1/domains/' + fqdn)
        .query({ token: dnsConfig.token })
        .send(data)
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 400) return callback(new DomainsError(DomainsError.BAD_FIELD, result.body.message));
            if (result.statusCode === 420) return callback(new DomainsError(DomainsError.STILL_BUSY));
            if (result.statusCode !== 201) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

            return callback(null);
        });
}

function get(domainObject, location, type, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    const dnsConfig = domainObject.config;
    const fqdn = location !== '' && type === 'TXT' ? location + '.' + domainObject.domain : getFqdn(location, domainObject.domain);

    debug('get: zoneName: %s subdomain: %s type: %s fqdn: %s', domainObject.domain, location, type, fqdn);

    superagent
        .get(config.apiServerOrigin() + '/api/v1/domains/' + fqdn)
        .query({ token: dnsConfig.token, type: type })
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

            return callback(null, result.body.values);
        });
}

function del(domainObject, location, type, values, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    const dnsConfig = domainObject.config;
    debug('del: %s for zone %s of type %s with values %j', location, domainObject.domain, type, values);

    var data = {
        type: type,
        values: values
    };

    superagent
        .del(config.apiServerOrigin() + '/api/v1/domains/' + getFqdn(location, domainObject.domain))
        .query({ token: dnsConfig.token })
        .send(data)
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 400) return callback(new DomainsError(DomainsError.BAD_FIELD, result.body.message));
            if (result.statusCode === 420) return callback(new DomainsError(DomainsError.STILL_BUSY));
            if (result.statusCode === 404) return callback(new DomainsError(DomainsError.NOT_FOUND));
            if (result.statusCode !== 204) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

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

    const dnsConfig = domainObject.config;

    if (!dnsConfig.token || typeof dnsConfig.token !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'token must be a non-empty string'));

    const ip = '127.0.0.1';

    var credentials = {
        token: dnsConfig.token,
        hyphenatedSubdomains: true  // this will ensure we always use them, regardless of passed-in configs
    };

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
}
