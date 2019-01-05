'use strict';

exports = module.exports = {
    upsert: upsert,
    get: get,
    del: del,
    wait: wait,
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    async = require('async'),
    debug = require('debug')('box:dns/cloudflare'),
    dns = require('../native-dns.js'),
    domains = require('../domains.js'),
    DomainsError = require('../domains.js').DomainsError,
    superagent = require('superagent'),
    util = require('util'),
    waitForDns = require('./waitfordns.js'),
    _ = require('underscore');

// we are using latest v4 stable API https://api.cloudflare.com/#getting-started-endpoints
var CLOUDFLARE_ENDPOINT = 'https://api.cloudflare.com/client/v4';

function translateRequestError(result, callback) {
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (result.statusCode === 404) return callback(new DomainsError(DomainsError.NOT_FOUND, util.format('%s %j', result.statusCode, 'API does not exist')));
    if (result.statusCode === 422) return callback(new DomainsError(DomainsError.BAD_FIELD, result.body.message));
    if ((result.statusCode === 400 || result.statusCode === 401 || result.statusCode === 403) && result.body.errors.length > 0) {
        let error = result.body.errors[0];
        let message = `message: ${error.message} statusCode: ${result.statusCode} code:${error.code}`;
        return callback(new DomainsError(DomainsError.ACCESS_DENIED, message));
    }

    callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));
}

function getZoneByName(dnsConfig, zoneName, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof callback, 'function');

    superagent.get(CLOUDFLARE_ENDPOINT + '/zones?name=' + zoneName + '&status=active')
        .set('X-Auth-Key', dnsConfig.token)
        .set('X-Auth-Email', dnsConfig.email)
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(error);
            if (result.statusCode !== 200 || result.body.success !== true) return translateRequestError(result, callback);
            if (!result.body.result.length) return callback(new DomainsError(DomainsError.NOT_FOUND, util.format('%s %j', result.statusCode, result.body)));

            callback(null, result.body.result[0]);
        });
}

// gets records filtered by zone, type and fqdn
function getDnsRecords(dnsConfig, zoneId, fqdn, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneId, 'string');
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    superagent.get(CLOUDFLARE_ENDPOINT + '/zones/' + zoneId + '/dns_records')
        .set('X-Auth-Key',dnsConfig.token)
        .set('X-Auth-Email',dnsConfig.email)
        .query({ type: type, name: fqdn })
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(error);
            if (result.statusCode !== 200 || result.body.success !== true) return translateRequestError(result, callback);

            var tmp = result.body.result;

            return callback(null, tmp);
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
        fqdn = domains.fqdn(location, domainObject);

    debug('upsert: %s for zone %s of type %s with values %j', fqdn, zoneName, type, values);

    getZoneByName(dnsConfig, zoneName, function(error, result) {
        if (error) return callback(error);

        let zoneId = result.id;

        getDnsRecords(dnsConfig, zoneId, fqdn, type, function (error, dnsRecords) {
            if (error) return callback(error);

            let i = 0; // // used to track available records to update instead of create

            async.eachSeries(values, function (value, iteratorCallback) {
                var priority = null;

                if (type === 'MX') {
                    priority = parseInt(value.split(' ')[0], 10);
                    value = value.split(' ')[1];
                }

                var data = {
                    type: type,
                    name: fqdn,
                    content: value,
                    priority: priority,
                    proxied: false,
                    ttl: 120  // 1 means "automatic" (meaning 300ms) and 120 is the lowest supported
                };

                if (i >= dnsRecords.length) { // create a new record
                    debug(`upsert: Adding new record fqdn: ${fqdn}, zoneName: ${zoneName} proxied: false`);

                    superagent.post(CLOUDFLARE_ENDPOINT + '/zones/' + zoneId + '/dns_records')
                        .set('X-Auth-Key', dnsConfig.token)
                        .set('X-Auth-Email', dnsConfig.email)
                        .send(data)
                        .timeout(30 * 1000)
                        .end(function (error, result) {
                            if (error && !error.response) return iteratorCallback(error);
                            if (result.statusCode !== 200 || result.body.success !== true) return translateRequestError(result, iteratorCallback);

                            iteratorCallback(null);
                        });
                } else { // replace existing record
                    data.proxied = dnsRecords[i].proxied; // preserve proxied parameter

                    debug(`upsert: Updating existing record fqdn: ${fqdn}, zoneName: ${zoneName} proxied: ${data.proxied}`);

                    superagent.put(CLOUDFLARE_ENDPOINT + '/zones/' + zoneId + '/dns_records/' + dnsRecords[i].id)
                        .set('X-Auth-Key', dnsConfig.token)
                        .set('X-Auth-Email', dnsConfig.email)
                        .send(data)
                        .timeout(30 * 1000)
                        .end(function (error, result) {
                            ++i; // increment, as we have consumed the record

                            if (error && !error.response) return iteratorCallback(error);
                            if (result.statusCode !== 200 || result.body.success !== true) return translateRequestError(result, iteratorCallback);

                            iteratorCallback(null);
                        });
                }
            }, callback);
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
        fqdn = domains.fqdn(location, domainObject);

    getZoneByName(dnsConfig, zoneName, function(error, zone) {
        if (error) return callback(error);

        getDnsRecords(dnsConfig, zone.id, fqdn, type, function (error, result) {
            if (error) return callback(error);

            var tmp = result.map(function (record) { return record.content; });
            debug('get: %j', tmp);

            callback(null, tmp);
        });
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
        fqdn = domains.fqdn(location, domainObject);

    getZoneByName(dnsConfig, zoneName, function(error, zone) {
        if (error) return callback(error);

        getDnsRecords(dnsConfig, zone.id, fqdn, type, function(error, result) {
            if (error) return callback(error);
            if (result.length === 0) return callback(null);

            var zoneId = result[0].zone_id;

            var tmp = result.filter(function (record) { return values.some(function (value) { return value === record.content; }); });
            debug('del: %j', tmp);

            if (tmp.length === 0) return callback(null);

            async.eachSeries(tmp, function (record, callback) {
                superagent.del(CLOUDFLARE_ENDPOINT + '/zones/'+ zoneId + '/dns_records/' + record.id)
                    .set('X-Auth-Key', dnsConfig.token)
                    .set('X-Auth-Email', dnsConfig.email)
                    .timeout(30 * 1000)
                    .end(function (error, result) {
                        if (error && !error.response) return callback(error);
                        if (result.statusCode !== 200 || result.body.success !== true) return translateRequestError(result, callback);

                        debug('del: done');

                        callback(null);
                    });
            }, function (error) {
                if (error) return callback(error);

                callback(null, 'unused');
            });
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
    if (!dnsConfig.email || typeof dnsConfig.email !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'email must be a non-empty string'));

    const ip = '127.0.0.1';

    var credentials = {
        token: dnsConfig.token,
        email: dnsConfig.email
    };

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        getZoneByName(dnsConfig, zoneName, function(error, zone) {
            if (error) return callback(error);

            if (!_.isEqual(zone.name_servers.sort(), nameservers.sort())) {
                debug('verifyDnsConfig: %j and %j do not match', nameservers, zone.name_servers);
                return callback(new DomainsError(DomainsError.BAD_FIELD, 'Domain nameservers are not set to Cloudflare'));
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
    });
}
