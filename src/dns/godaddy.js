'use strict';

exports = module.exports = {
    upsert: upsert,
    get: get,
    del: del,
    waitForDns: require('./waitfordns.js'),
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    debug = require('debug')('box:dns/godaddy'),
    dns = require('../native-dns.js'),
    DomainsError = require('../domains.js').DomainsError,
    superagent = require('superagent'),
    util = require('util');

// const GODADDY_API_OTE = 'https://api.ote-godaddy.com/v1/domains';
const GODADDY_API = 'https://api.godaddy.com/v1/domains';

function formatError(response) {
    return util.format(`GoDaddy DNS error [${response.statusCode}] ${response.body.message}`);
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

    superagent.put(`${GODADDY_API}/${zoneName}/records/${type}/${subdomain}`)
        .set('Authorization', `sso-key ${dnsConfig.apiKey}:${dnsConfig.apiSecret}`)
        .timeout(30 * 1000)
        .send(records)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode === 400) return callback(new DomainsError(DomainsError.BAD_FIELD, formatError(result))); // no such zone
            if (result.statusCode === 422) return callback(new DomainsError(DomainsError.BAD_FIELD, formatError(result))); // conflict
            if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

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

    superagent.get(`${GODADDY_API}/${zoneName}/records/${type}/${subdomain}`)
        .set('Authorization', `sso-key ${dnsConfig.apiKey}:${dnsConfig.apiSecret}`)
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode === 404) return callback(null, [ ]);
            if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

            debug('get: %j', result.body);

            var values = result.body.map(function (record) { return record.data; });

            return callback(null, values);
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

    superagent.put(`${GODADDY_API}/${zoneName}/records/${type}/${subdomain}`)
        .set('Authorization', `sso-key ${dnsConfig.apiKey}:${dnsConfig.apiSecret}`)
        .send([ ])
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, util.format('Network error %s', error.message)));
            if (result.statusCode === 404) return callback(null);
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

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
