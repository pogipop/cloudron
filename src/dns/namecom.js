'use strict';

exports = module.exports = {
    upsert: upsert,
    get: get,
    del: del,
    waitForDns: require('./waitfordns.js'),
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    debug = require('debug')('box:dns/namecom'),
    dns = require('../native-dns.js'),
    safe = require('safetydance'),
    DomainsError = require('../domains.js').DomainsError,
    superagent = require('superagent');

const NAMECOM_API = 'https://api.name.com/v4';

function formatError(response) {
    return `Name.com DNS error [${response.statusCode}] ${response.text}`;
}

function addRecord(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(Array.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug(`add: ${subdomain} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    var data = {
        host: subdomain,
        type: type,
        ttl: 300    // 300 is the lowest
    };

    if (type === 'MX') {
        data.priority = parseInt(values[0].split(' ')[0], 10);
        data.answer = values[0].split(' ')[1];
    } else {
        data.answer = values[0];
    }

    superagent.post(`${NAMECOM_API}/domains/${zoneName}/records`)
        .auth(dnsConfig.username, dnsConfig.token)
        .timeout(30 * 1000)
        .send(data)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, `Network error ${error.message}`));
            if (result.statusCode === 403) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

            return callback(null, 'unused-id');
        });
}

function updateRecord(dnsConfig, zoneName, recordId, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof recordId, 'number');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(Array.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug(`update:${recordId} on ${subdomain} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    var data = {
        host: subdomain,
        type: type,
        ttl: 300    // 300 is the lowest
    };

    if (type === 'MX') {
        data.priority = parseInt(values[0].split(' ')[0], 10);
        data.answer = values[0].split(' ')[1];
    } else {
        data.answer = values[0];
    }

    superagent.put(`${NAMECOM_API}/domains/${zoneName}/records/${recordId}`)
        .auth(dnsConfig.username, dnsConfig.token)
        .timeout(30 * 1000)
        .send(data)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, `Network error ${error.message}`));
            if (result.statusCode === 403) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

            return callback(null);
        });
}

function getInternal(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    subdomain = subdomain || '@';

    debug(`getInternal: ${subdomain} in zone ${zoneName} of type ${type}`);

    superagent.get(`${NAMECOM_API}/domains/${zoneName}/records`)
        .auth(dnsConfig.username, dnsConfig.token)
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, `Network error ${error.message}`));
            if (result.statusCode === 403) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
            if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

            // name.com does not return the correct content-type
            result.body = safe.JSON.parse(result.text);
            if (!result.body.records) result.body.records = [];

            result.body.records.forEach(function (r) {
                // name.com api simply strips empty properties
                r.host = r.host || '@';
            });

            var results = result.body.records.filter(function (r) {
                return (r.host === subdomain && r.type === type);
            });

            debug('getInternal: %j', results);

            return callback(null, results);
        });
}

function upsert(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(Array.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    subdomain = subdomain || '@';

    debug(`upsert: ${subdomain} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    getInternal(dnsConfig, zoneName, subdomain, type, function (error, result) {
        if (error) return callback(error);

        if (result.length === 0) return addRecord(dnsConfig, zoneName, subdomain, type, values, callback);

        return updateRecord(dnsConfig, zoneName, result[0].id, subdomain, type, values, callback);
    });
}

function get(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    getInternal(dnsConfig, zoneName, subdomain, type, function (error, result) {
        if (error) return callback(error);

        var tmp = result.map(function (record) { return record.answer; });

        debug('get: %j', tmp);

        return callback(null, tmp);
    });
}

function del(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(Array.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    subdomain = subdomain || '@';

    debug(`del: ${subdomain} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    getInternal(dnsConfig, zoneName, subdomain, type, function (error, result) {
        if (error) return callback(error);

        if (result.length === 0) return callback();

        superagent.del(`${NAMECOM_API}/domains/${zoneName}/records/${result[0].id}`)
            .auth(dnsConfig.username, dnsConfig.token)
            .timeout(30 * 1000)
            .end(function (error, result) {
                if (error && !error.response) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, `Network error ${error.message}`));
                if (result.statusCode === 403) return callback(new DomainsError(DomainsError.ACCESS_DENIED, formatError(result)));
                if (result.statusCode !== 200) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(result)));

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

    if (typeof dnsConfig.username !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'username must be a string'));
    if (typeof dnsConfig.token !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'token must be a string'));
    if ('hyphenatedSubdomains' in dnsConfig && typeof dnsConfig.hyphenatedSubdomains !== 'boolean') return callback(new DomainsError(DomainsError.BAD_FIELD, 'hyphenatedSubdomains must be a boolean'));

    var credentials = {
        username: dnsConfig.username,
        token: dnsConfig.token,
        hyphenatedSubdomains: !!dnsConfig.hyphenatedSubdomains
    };

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        if (!nameservers.every(function (n) { return n.toLowerCase().indexOf('.name.com') !== -1; })) {
            debug('verifyDnsConfig: %j does not contain Name.com NS', nameservers);
            return callback(new DomainsError(DomainsError.BAD_FIELD, 'Domain nameservers are not set to Name.com'));
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
