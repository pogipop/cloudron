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
    debug = require('debug')('box:dns/cloudflare'),
    dns = require('dns'),
    DomainError = require('../domains.js').DomainError,
    superagent = require('superagent'),
    util = require('util'),
    _ = require('underscore');

// we are using latest v4 stable API https://api.cloudflare.com/#getting-started-endpoints
var CLOUDFLARE_ENDPOINT = 'https://api.cloudflare.com/client/v4';

function translateRequestError(result, callback) {
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (result.statusCode === 404) return callback(new DomainError(DomainError.NOT_FOUND, util.format('%s %j', result.statusCode, 'API does not exist')));
    if (result.statusCode === 422) return callback(new DomainError(DomainError.BAD_FIELD, result.body.message));
    if ((result.statusCode === 400 || result.statusCode === 401 || result.statusCode === 403) && result.body.errors.length > 0) {
        let error = result.body.errors[0];
        let message = error.message;
        if (error.code === 6003) {
            if (error.error_chain[0] && error.error_chain[0].code === 6103) message = 'Invalid API Key';
            else message = 'Invalid credentials';
        }

        return callback(new DomainError(DomainError.ACCESS_DENIED, message));
    }

    callback(new DomainError(DomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));
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
        if (!result.body.result.length) return callback(new DomainError(DomainError.NOT_FOUND, util.format('%s %j', result.statusCode, result.body)));

        callback(null, result.body.result[0]);
    });
}

function getDNSRecordsByZoneId(dnsConfig, zoneId, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneId, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    var fqdn = subdomain === '' ? zoneName : subdomain + '.' + zoneName;

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

function upsert(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    var fqdn = subdomain === '' ? zoneName : subdomain + '.' + zoneName;

    debug('upsert: %s for zone %s of type %s with values %j', subdomain, zoneName, type, values);

    getZoneByName(dnsConfig, zoneName, function(error, result){
        if (error) return callback(error);

        var zoneId = result.id;

        getDNSRecordsByZoneId(dnsConfig, zoneId, zoneName, subdomain, type, function (error, result) {
            if (error) return callback(error);

            var dnsRecords = result;

            // used to track available records to update instead of create
            var i = 0;

            async.eachSeries(values, function (value, callback) {
                var priority = null;

                if (type === 'MX') {
                    priority = value.split(' ')[0];
                    value = value.split(' ')[1];
                }

                var data = {
                    type: type,
                    name: fqdn,
                    content: value,
                    priority: priority,
                    ttl: 120  // 1 means "automatic" (meaning 300ms) and 120 is the lowest supported
                };

                if (i >= dnsRecords.length) {
                    superagent.post(CLOUDFLARE_ENDPOINT + '/zones/'+ zoneId + '/dns_records')
                      .set('X-Auth-Key',dnsConfig.token)
                      .set('X-Auth-Email',dnsConfig.email)
                      .send(data)
                      .timeout(30 * 1000)
                      .end(function (error, result) {
                        if (error && !error.response) return callback(error);
                        if (result.statusCode !== 200 || result.body.success !== true) return translateRequestError(result, callback);

                        callback(null);
                    });
                } else {
                    superagent.put(CLOUDFLARE_ENDPOINT + '/zones/'+ zoneId + '/dns_records/' + dnsRecords[i].id)
                      .set('X-Auth-Key',dnsConfig.token)
                      .set('X-Auth-Email',dnsConfig.email)
                      .send(data)
                      .timeout(30 * 1000)
                      .end(function (error, result) {
                        // increment, as we have consumed the record
                        ++i;

                        if (error && !error.response) return callback(error);
                        if (result.statusCode !== 200 || result.body.success !== true) return translateRequestError(result, callback);

                        callback(null);
                    });
                }
            }, function (error) {
                if (error) return callback(error);

                callback(null, 'unused');
            });
        });
    });
}

function get(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    getZoneByName(dnsConfig, zoneName, function(error, result){
        if (error) return callback(error);

        getDNSRecordsByZoneId(dnsConfig, result.id, zoneName, subdomain, type, function(error, result) {
            if (error) return callback(error);

            var tmp = result.map(function (record) { return record.content; });
            debug('get: %j', tmp);

            callback(null, tmp);
        });
    });
}

function del(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    getZoneByName(dnsConfig, zoneName, function(error, result){
        if (error) return callback(error);

        getDNSRecordsByZoneId(dnsConfig, result.id, zoneName, subdomain, type, function(error, result) {
            if (error) return callback(error);
            if (result.length === 0) return callback(null);

            var zoneId = result[0].zone_id;

            var tmp = result.filter(function (record) { return values.some(function (value) { return value === record.content; }); });
            debug('del: %j', tmp);

            if (tmp.length === 0) return callback(null);

            async.eachSeries(tmp, function (record, callback) {
                superagent.del(CLOUDFLARE_ENDPOINT + '/zones/'+ zoneId + '/dns_records/' + record.id)
                  .set('X-Auth-Key',dnsConfig.token)
                  .set('X-Auth-Email',dnsConfig.email)
                  .timeout(30 * 1000)
                  .end(function (error, result) {
                    if (error && !error.response) return callback(error);
                    if (result.statusCode !== 204 || result.body.success !== true) return translateRequestError(result, callback);

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

function verifyDnsConfig(dnsConfig, fqdn, zoneName, ip, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!dnsConfig.token || typeof dnsConfig.token !== 'string') return callback(new DomainError(DomainError.BAD_FIELD, 'token must be a non-empty string'));
    if (!dnsConfig.email || typeof dnsConfig.email !== 'string') return callback(new DomainError(DomainError.BAD_FIELD, 'email must be a non-empty string'));

    var credentials = {
        provider: dnsConfig.provider,
        token: dnsConfig.token,
        email: dnsConfig.email
    };

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolveNs(zoneName, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainError(DomainError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainError(DomainError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        getZoneByName(dnsConfig, zoneName, function(error, result) {
            if (error) return callback(error);

            if (!_.isEqual(result.name_servers.sort(), nameservers.sort())) {
                debug('verifyDnsConfig: %j and %j do not match', nameservers, result.name_servers);
                return callback(new DomainError(DomainError.BAD_FIELD, 'Domain nameservers are not set to Cloudflare'));
            }

            upsert(credentials, zoneName, 'my', 'A', [ ip ], function (error, changeId) {
                if (error) return callback(error);

                debug('verifyDnsConfig: A record added with change id %s', changeId);

                callback(null, credentials);
            });
        });
    });
}
