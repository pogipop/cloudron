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
    constants = require('../constants.js'),
    debug = require('debug')('box:dns/digitalocean'),
    dns = require('dns'),
    SubdomainError = require('../subdomains.js').SubdomainError,
    superagent = require('superagent'),
    util = require('util');

var DIGITALOCEAN_ENDPOINT = 'https://api.digitalocean.com';

function formatError(response) {
    return util.format('DigitalOcean DNS error [%s] %j', response.statusCode, response.body);
}

function getInternal(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    var nextPage = null, matchingRecords = [];

    async.doWhilst(function (iteratorDone) {
        var url = nextPage ? nextPage : DIGITALOCEAN_ENDPOINT + '/v2/domains/' + zoneName + '/records';

        superagent.get(url)
          .set('Authorization', 'Bearer ' + dnsConfig.token)
          .timeout(30 * 1000)
          .end(function (error, result) {
            if (error && !error.response) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 404) return callback(new SubdomainError(SubdomainError.NOT_FOUND, formatError(result)));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode !== 200) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, formatError(result)));

            matchingRecords = matchingRecords.concat(result.body.domain_records.filter(function (record) {
                return (record.type === type && record.name === subdomain);
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

function upsert(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    subdomain = subdomain || '@';

    debug('upsert: %s for zone %s of type %s with values %j', subdomain, zoneName, type, values);

    getInternal(dnsConfig, zoneName, subdomain, type, function (error, result) {
        if (error) return callback(error);

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
                name: subdomain,
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
                    if (error && !error.response) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
                    if (result.statusCode === 403 || result.statusCode === 401) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, formatError(result)));
                    if (result.statusCode === 422) return callback(new SubdomainError(SubdomainError.BAD_FIELD, result.body.message));
                    if (result.statusCode !== 201) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, formatError(result)));

                    return callback(null);
                });
            } else {
                superagent.put(DIGITALOCEAN_ENDPOINT + '/v2/domains/' + zoneName + '/records/' + result[i].id)
                  .set('Authorization', 'Bearer ' + dnsConfig.token)
                  .send(data)
                  .timeout(30 * 1000)
                  .end(function (error, result) {
                    // increment, as we have consumed the record
                    ++i;

                    if (error && !error.response) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
                    if (result.statusCode === 403 || result.statusCode === 401) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, formatError(result)));
                    if (result.statusCode === 422) return callback(new SubdomainError(SubdomainError.BAD_FIELD, result.body.message));
                    if (result.statusCode !== 200) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, formatError(result)));

                    return callback(null);
                });
            }
        }, function (error) {
            if (error) return callback(error);

            callback(null, 'unused');
        });
    });
}

function get(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    subdomain = subdomain || '@';

    getInternal(dnsConfig, zoneName, subdomain, type, function (error, result) {
        if (error) return callback(error);

        // We only return the value string
        var tmp = result.map(function (record) { return record.data; });

        debug('get: %j', tmp);

        return callback(null, tmp);
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

    getInternal(dnsConfig, zoneName, subdomain, type, function (error, result) {
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
            if (error && !error.response) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 404) return callback(null);
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode !== 204) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, formatError(result)));

            debug('del: done');

            return callback(null);
        });
    });
}

function verifyDnsConfig(dnsConfig, fqdn, zoneName, ip, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    var credentials = {
        provider: dnsConfig.provider,
        token: dnsConfig.token
    };

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolveNs(zoneName, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new SubdomainError(SubdomainError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new SubdomainError(SubdomainError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        if (nameservers.map(function (n) { return n.toLowerCase(); }).indexOf('ns1.digitalocean.com') === -1) {
            debug('verifyDnsConfig: %j does not contains DO NS', nameservers);
            return callback(new SubdomainError(SubdomainError.BAD_FIELD, 'Domain nameservers are not set to Digital Ocean'));
        }

        const name = constants.ADMIN_LOCATION + (fqdn === zoneName ? '' :  '.' + fqdn.slice(0, - zoneName.length - 1));

        upsert(credentials, zoneName, name, 'A', [ ip ], function (error, changeId) {
            if (error) return callback(error);

            debug('verifyDnsConfig: A record added with change id %s', changeId);

            callback(null, credentials);
        });
    });
}
