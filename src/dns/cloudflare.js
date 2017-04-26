'use strict';

// -------------------------------------------
//  This file just describes the interface
//
//  New backends can start from here
// -------------------------------------------

exports = module.exports = {
    upsert: upsert,
    get: get,
    del: del,
    // waitForDns: require('./waitfordns.js'),
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    async = require('async'),
    dns = require('dns'),
    _ = require('underscore'),
    SubdomainError = require('../subdomains.js').SubdomainError,
    superagent = require('superagent'),
    debug = require('debug')('box:dns/cloudflare'),

    util = require('util');

// we are using lated v4 stable API https://api.cloudflare.com/#getting-started-endpoints
var CLOUDFLARE_ENDPOINT = "https://api.cloudflare.com/client/v4";

// Get the zone details by zoneName
// this will return the 1st active zone record
function getZoneByName(dnsConfig, zoneName, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof callback, 'function');
    superagent.get(CLOUDFLARE_ENDPOINT + '/zones?name=' + zoneName + '&status=active')
      .set('X-Auth-Key',dnsConfig.token)
      .set('X-Auth-Email',dnsConfig.email)
      .timeout(30 * 1000)
      .end(function (error, result) {
        if (error && !error.response) return callback(error);
        if (result.statusCode === 404) return callback(new SubdomainError(SubdomainError.NOT_FOUND, util.format('%s %j', result.statusCode, result.body)));
        if (result.statusCode === 403 || result.statusCode === 401) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, util.format('%s %j', result.statusCode, result.body)));
        if (result.statusCode !== 200) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));
        if (result.body.success !== true) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

        if(result.body.result.length) {
            return callback(null, result.body.result[0]);
        }

        return callback(new SubdomainError(SubdomainError.NOT_FOUND, util.format('%s %j', result.statusCode, result.body)));
    });
}

function getDNSRecordsByZoneName(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');
    var fqdn = subdomain === '' ? zoneName : subdomain + '.' + zoneName;

    getZoneByName(dnsConfig, zoneName, function(error, result){
        if (error && !error.response) return callback(error);

        var zone = result;
        superagent.get(CLOUDFLARE_ENDPOINT + '/zones/'+ zone.id + '/dns_records')
          .set('X-Auth-Key',dnsConfig.token)
          .set('X-Auth-Email',dnsConfig.email)
          .timeout(30 * 1000)
          .end(function (error, result) {
              if (error && !error.response) return callback(error);
              if (result.statusCode === 404) return callback(new SubdomainError(SubdomainError.NOT_FOUND, util.format('%s %j', result.statusCode, result.body)));
              if (result.statusCode === 403 || result.statusCode === 401) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, util.format('%s %j', result.statusCode, result.body)));
              if (result.statusCode !== 200) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));
              if (result.body.success !== true) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));
              if (result.body.result.length <= 0) {
                  return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('%s %s', result.statusCode, 'No Dns record found')));
              }

              var tmp = result.body.result.filter(function (record) {
                  return (record.type === type && record.name === fqdn);
              });

              return callback(null, tmp);
          });
    });
}

// Update or insert the DNS record
function upsert(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    var fqdn = subdomain === '' ? zoneName : subdomain + '.' + zoneName;


    debug('upsert: %s for zone %s of type %s with values %j', subdomain, zoneName, type, values);

    // Result: backend specific change id, to be passed into getChangeStatus()
    getDNSRecordsByZoneName(dnsConfig, zoneName, fqdn, type, function(error, result) {
        if (error) return callback(error);

        var dnsRecords = result;
        var zoneId = dnsRecords[0].zone_id;
        // used to track available records to update instead of create
        var i = 0;

        async.eachSeries(values, function (value, callback) {
            var data = {
                type: type,
                name: fqdn,
                content: value
            };

            if (i >= dnsRecords.length) {
                superagent.post(CLOUDFLARE_ENDPOINT + '/zones/'+ zoneId + '/dns_records')
                  .set('X-Auth-Key',dnsConfig.token)
                  .set('X-Auth-Email',dnsConfig.email)
                  .send(data)
                  .timeout(30 * 1000)
                  .end(function (error, result) {
                    if (error && !error.response) return callback(error);
                    if (result.statusCode === 403 || result.statusCode === 401) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, util.format('%s %j', result.statusCode, result.body)));
                    if (result.statusCode === 422) return callback(new SubdomainError(SubdomainError.BAD_FIELD, result.body.message));
                    if (result.statusCode !== 201) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));
                    if (result.body.success !== true) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

                    return callback(null);
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
                    if (result.statusCode === 403 || result.statusCode === 401) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, util.format('%s %j', result.statusCode, result.body)));
                    if (result.statusCode === 422) return callback(new SubdomainError(SubdomainError.BAD_FIELD, result.body.message));
                    if (result.statusCode !== 200) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));
                    if (result.body.success !== true) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

                    return callback(null);
                });
            }
        }, function (error) {
            if (error) return callback(error);

            callback(null, 'unused');
        });
    });
}

// get specific DNS record
function get(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: Array of matching DNS records in string format
    getDNSRecordsByZoneName(dnsConfig, zoneName, subdomain, type, function(error, result) {
        if (error) return callback(error);

        var tmp = result.map(function (record) { return record.content; });
        debug('get: %j', tmp);

        return callback(null, tmp);
    });
}

// delete dns record
function del(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    getDNSRecordsByZoneName(dnsConfig, zoneName, subdomain, type, function(error, result) {
        if (error) return callback(error);
        if (result.length === 0) return callback(null);

        var zoneId = result[0].zone_id;

        var tmp = result.filter(function (record) { return values.some(function (value) { return value === record.content; }); });
        debug('del: %j', tmp);

        if (tmp.length === 0) return callback(null);

        async.eachSeries(tmp, function (record, callback) {
            superagent.del(CLOUDFLARE_ENDPOINT + '/zones/'+ zoneId + '/dns_records/' + record.id)
              .set('Authorization', 'Bearer ' + dnsConfig.token)
              .timeout(30 * 1000)
              .end(function (error, result) {
                if (error && !error.response) return callback(error);
                if (result.statusCode === 404) return callback(null);
                if (result.statusCode === 403 || result.statusCode === 401) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, util.format('%s %j', result.statusCode, result.body)));
                if (result.statusCode !== 204) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

                debug('del: done');

                return callback(null);
            });

        },
        function (error) {
            if (error) return callback(error);

            callback(null, 'unused');
        });

    });
}

// verify Dns Configuration
function verifyDnsConfig(dnsConfig, domain, ip, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    // Result: dnsConfig object
    var credentials = {
        provider: dnsConfig.provider,
        token: dnsConfig.token
    };

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolveNs(domain, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new SubdomainError(SubdomainError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new SubdomainError(SubdomainError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));
        getZoneByName(dnsConfig, domain, function(error, result) {

            if (error) return callback(error);
            if (!_.isEqual(result.name_servers.sort(), nameservers.sort())) {
                debug('verifyDnsConfig: %j and %j do not match', nameservers, result.name_servers);
                return callback(new SubdomainError(SubdomainError.BAD_FIELD, 'Domain nameservers are not set to Route53'));
            }
            upsert(credentials, domain, 'my', 'A', [ ip ], function (error, changeId) {
                if (error) return callback(error);

                debug('verifyDnsConfig: A record added with change id %s', changeId);

                callback(null, credentials);
            });

        });
    });
}
