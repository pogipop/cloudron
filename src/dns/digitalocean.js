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
    async = require('async'),
    debug = require('debug')('box:dns/digitalocean'),
    dns = require('../native-dns.js'),
    domains = require('../domains.js'),
    DomainsError = require('../domains.js').DomainsError,
    safe = require('safetydance'),
    superagent = require('superagent'),
    util = require('util'),
    waitForDns = require('./waitfordns.js');

var DIGITALOCEAN_ENDPOINT = 'https://api.digitalocean.com';

function formatError(response) {
    return util.format('DigitalOcean DNS error [%s] %j', response.statusCode, response.body);
}

function removePrivateFields(domainObject) {
    domainObject.config.token = domains.SECRET_PLACEHOLDER;
    return domainObject;
}

function injectPrivateFields(newConfig, currentConfig) {
    if (newConfig.token === domains.SECRET_PLACEHOLDER) newConfig.token = currentConfig.token;
}

function getInternal(dnsConfig, zoneName, name, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    var nextPage = null, matchingRecords = [];

    async.doWhilst(function (iteratorDone) {
        var url = nextPage ? nextPage : DIGITALOCEAN_ENDPOINT + '/v2/domains/' + zoneName + '/records';

        superagent.get(url)
            .set('Authorization', 'Bearer ' + dnsConfig.token)
            .timeout(30 * 1000)
            .end(function (error, result) {
                if (error && !error.response) return iteratorDone(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
                if (result.statusCode === 404) return iteratorDone(new DomainsError(DomainsError.NOT_FOUND, formatError(result)));
                if (result.statusCode === 403 || result.statusCode === 401) return iteratorDone(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
                if (result.statusCode !== 200) return iteratorDone(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

                matchingRecords = matchingRecords.concat(result.body.domain_records.filter(function (record) {
                    return (record.type === type && record.name === name);
                }));

                nextPage = (result.body.links && result.body.links.pages) ? result.body.links.pages.next : null;

                iteratorDone();
            });
    }, function () { return !!nextPage; }, function (error) {
        if (error) return callback(error);

        debug('getInternal: %j', matchingRecords);

        return callback(null, matchingRecords);
    });
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

    debug('upsert: %s for zone %s of type %s with values %j', name, zoneName, type, values);

    getInternal(dnsConfig, zoneName, name, type, function (error, result) {
        if (error) return callback(error);

        // used to track available records to update instead of create
        var i = 0, recordIds = [];

        async.eachSeries(values, function (value, iteratorCallback) {
            var priority = null;

            if (type === 'MX') {
                priority = value.split(' ')[0];
                value = value.split(' ')[1];
            }

            var data = {
                type: type,
                name: name,
                data: value,
                priority: priority,
                ttl: 1
            };

            if (i >= result.length) {
                superagent.post(DIGITALOCEAN_ENDPOINT + '/v2/domains/' + zoneName + '/records')
                    .set('Authorization', 'Bearer ' + dnsConfig.token)
                    .send(data)
                    .timeout(30 * 1000)
                    .end(function (error, result) {
                        if (error && !error.response) return iteratorCallback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
                        if (result.statusCode === 403 || result.statusCode === 401) return iteratorCallback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
                        if (result.statusCode === 422) return iteratorCallback(new DomainsError(DomainsError.BAD_FIELD, result.body.message));
                        if (result.statusCode !== 201) return iteratorCallback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

                        recordIds.push(safe.query(result.body, 'domain_record.id'));

                        return iteratorCallback(null);
                    });
            } else {
                superagent.put(DIGITALOCEAN_ENDPOINT + '/v2/domains/' + zoneName + '/records/' + result[i].id)
                    .set('Authorization', 'Bearer ' + dnsConfig.token)
                    .send(data)
                    .timeout(30 * 1000)
                    .end(function (error, result) {
                    // increment, as we have consumed the record
                        ++i;

                        if (error && !error.response) return iteratorCallback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
                        if (result.statusCode === 403 || result.statusCode === 401) return iteratorCallback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
                        if (result.statusCode === 422) return iteratorCallback(new DomainsError(DomainsError.BAD_FIELD, result.body.message));
                        if (result.statusCode !== 200) return iteratorCallback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

                        recordIds.push(safe.query(result.body, 'domain_record.id'));

                        return iteratorCallback(null);
                    });
            }
        }, function (error) {
            if (error) return callback(error);

            debug('upsert: completed with recordIds:%j', recordIds);

            callback();
        });
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

    getInternal(dnsConfig, zoneName, name, type, function (error, result) {
        if (error) return callback(error);

        // We only return the value string
        var tmp = result.map(function (record) { return record.data; });

        debug('get: %j', tmp);

        return callback(null, tmp);
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

    getInternal(dnsConfig, zoneName, name, type, function (error, result) {
        if (error) return callback(error);

        if (result.length === 0) return callback(null);

        var tmp = result.filter(function (record) { return values.some(function (value) { return value === record.data; }); });

        debug('del: %j', tmp);

        if (tmp.length === 0) return callback(null);

        // FIXME we only handle the first one currently

        superagent.del(DIGITALOCEAN_ENDPOINT + '/v2/domains/' + zoneName + '/records/' + tmp[0].id)
            .set('Authorization', 'Bearer ' + dnsConfig.token)
            .timeout(30 * 1000)
            .end(function (error, result) {
                if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
                if (result.statusCode === 404) return callback(null);
                if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
                if (result.statusCode !== 204) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

                debug('del: done');

                return callback(null);
            });
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

    const ip = '127.0.0.1';

    var credentials = {
        token: dnsConfig.token
    };

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        if (nameservers.map(function (n) { return n.toLowerCase(); }).indexOf('ns1.digitalocean.com') === -1) {
            debug('verifyDnsConfig: %j does not contains DO NS', nameservers);
            return callback(new DomainsError(DomainsError.BAD_FIELD, 'Domain nameservers are not set to DigitalOcean'));
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
