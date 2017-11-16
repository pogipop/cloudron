'use strict';

exports = module.exports = {
    upsert: upsert,
    get: get,
    del: del,
    waitForDns: require('./waitfordns.js'),
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    config = require('../config.js'),
    debug = require('debug')('box:dns/caas'),
    DomainError = require('../domains.js').DomainError,
    superagent = require('superagent'),
    util = require('util');

function add(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    var fqdn = subdomain !== '' && type === 'TXT' ? subdomain + '.' + config.fqdn() : config.appFqdn({ location: subdomain, domain: zoneName });

    debug('add: %s for zone %s of type %s with values %j', subdomain, zoneName, type, values);

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
            if (error && !error.response) return callback(new DomainError(DomainError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 400) return callback(new DomainError(DomainError.BAD_FIELD, result.body.message));
            if (result.statusCode === 420) return callback(new DomainError(DomainError.STILL_BUSY));
            if (result.statusCode !== 201) return callback(new DomainError(DomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

            return callback(null, result.body.changeId);
        });
}

function get(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    var fqdn = subdomain !== '' && type === 'TXT' ? subdomain + '.' + config.fqdn() : config.appFqdn({ location: subdomain, domain: zoneName });

    debug('get: zoneName: %s subdomain: %s type: %s fqdn: %s', zoneName, subdomain, type, fqdn);

    superagent
        .get(config.apiServerOrigin() + '/api/v1/domains/' + fqdn)
        .query({ token: dnsConfig.token, type: type })
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainError(DomainError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode !== 200) return callback(new DomainError(DomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

            return callback(null, result.body.values);
        });
}

function upsert(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    add(dnsConfig, zoneName, subdomain, type, values, callback);
}

function del(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug('del: %s for zone %s of type %s with values %j', subdomain, zoneName, type, values);

    var data = {
        type: type,
        values: values
    };

    superagent
        .del(config.apiServerOrigin() + '/api/v1/domains/' + config.appFqdn({ location: subdomain, domain: zoneName }))
        .query({ token: dnsConfig.token })
        .send(data)
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainError(DomainError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 400) return callback(new DomainError(DomainError.BAD_FIELD, result.body.message));
            if (result.statusCode === 420) return callback(new DomainError(DomainError.STILL_BUSY));
            if (result.statusCode === 404) return callback(new DomainError(DomainError.NOT_FOUND));
            if (result.statusCode !== 204) return callback(new DomainError(DomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

            return callback(null);
        });
}

function verifyDnsConfig(dnsConfig, domain, zoneName, ip, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    var credentials = {
        provider: dnsConfig.provider
    };

    return callback(null, credentials);
}
