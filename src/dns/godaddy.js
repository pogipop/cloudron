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
    debug = require('debug')('box:dns/godaddy'),
    dns = require('../native-dns.js'),
    domains = require('../domains.js'),
    DomainsError = require('../domains.js').DomainsError,
    superagent = require('superagent'),
    util = require('util'),
    waitForDns = require('./waitfordns.js');

// const GODADDY_API_OTE = 'https://api.ote-godaddy.com/v1/domains';
const GODADDY_API = 'https://api.godaddy.com/v1/domains';

// this is a workaround for godaddy not having a delete API
// https://stackoverflow.com/questions/39347464/delete-record-libcloud-godaddy-api
const GODADDY_INVALID_IP = '0.0.0.0';
const GODADDY_INVALID_TXT = '""';

function formatError(response) {
    return util.format(`GoDaddy DNS error [${response.statusCode}] ${response.body.message}`);
}

function removePrivateFields(domainObject) {
    domainObject.config.apiSecret = domains.SECRET_PLACEHOLDER;
    return domainObject;
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

    var records = [ ];
    values.forEach(function (value) {
        var record = { ttl: 600 }; // 600 is the min ttl

        if (type === 'MX') {
            record.priority = parseInt(value.split(' ')[0], 10);
            record.data = value.split(' ')[1];
        } else {
            record.data = value;
        }

        records.push(record);
    });

    superagent.put(`${GODADDY_API}/${zoneName}/records/${type}/${name}`)
        .set('Authorization', `sso-key ${dnsConfig.apiKey}:${dnsConfig.apiSecret}`)
        .timeout(30 * 1000)
        .send(records)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode === 400) return callback(new DomainsError(DomainsError.BAD_FIELD, formatError(result))); // no such zone
            if (result.statusCode === 422) return callback(new DomainsError(DomainsError.BAD_FIELD, formatError(result))); // conflict
            if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

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

    superagent.get(`${GODADDY_API}/${zoneName}/records/${type}/${name}`)
        .set('Authorization', `sso-key ${dnsConfig.apiKey}:${dnsConfig.apiSecret}`)
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode === 404) return callback(null, [ ]);
            if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

            debug('get: %j', result.body);

            var values = result.body.map(function (record) { return record.data; });

            if (values.length === 1 && values[0] === GODADDY_INVALID_IP) return callback(null, [ ]); // pretend this record doesn't exist

            return callback(null, values);
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

    debug(`get: ${name} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    if (type !== 'A' && type !== 'TXT') return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, new Error('Record deletion is not supported by GoDaddy API')));

    // check if the record exists at all so that we don't insert the "Dead" record for no reason
    get(domainObject, location, type, function (error, values) {
        if (error) return callback(error);
        if (values.length === 0) return callback();

        // godaddy does not have a delete API. so fill it up with an invalid IP that we can ignore in future get()
        var records = [{
            ttl: 600,
            data: type === 'A' ? GODADDY_INVALID_IP : GODADDY_INVALID_TXT
        }];

        superagent.put(`${GODADDY_API}/${zoneName}/records/${type}/${name}`)
            .set('Authorization', `sso-key ${dnsConfig.apiKey}:${dnsConfig.apiSecret}`)
            .send(records)
            .timeout(30 * 1000)
            .end(function (error, result) {
                if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
                if (result.statusCode === 404) return callback(null);
                if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
                if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

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

    if (!dnsConfig.apiKey || typeof dnsConfig.apiKey !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'apiKey must be a non-empty string'));
    if (!dnsConfig.apiSecret || typeof dnsConfig.apiSecret !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'apiSecret must be a non-empty string'));

    const ip = '127.0.0.1';

    var credentials = {
        apiKey: dnsConfig.apiKey,
        apiSecret: dnsConfig.apiSecret
    };

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        if (!nameservers.every(function (n) { return n.toLowerCase().indexOf('.domaincontrol.com') !== -1; })) {
            debug('verifyDnsConfig: %j does not contain GoDaddy NS', nameservers);
            return callback(new DomainsError(DomainsError.BAD_FIELD, 'Domain nameservers are not set to GoDaddy'));
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
