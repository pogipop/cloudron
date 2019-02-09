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
    debug = require('debug')('box:dns/namecom'),
    dns = require('../native-dns.js'),
    domains = require('../domains.js'),
    DomainsError = require('../domains.js').DomainsError,
    safe = require('safetydance'),
    superagent = require('superagent'),
    util = require('util'),
    waitForDns = require('./waitfordns.js');

const NAMECOM_API = 'https://api.name.com/v4';

function formatError(response) {
    return `Name.com DNS error [${response.statusCode}] ${response.text}`;
}

function removePrivateFields(domainObject) {
    domainObject.config.token = domains.SECRET_PLACEHOLDER;
    return domainObject;
}

function injectPrivateFields(newConfig, currentConfig) {
    if (newConfig.token === domains.SECRET_PLACEHOLDER) newConfig.token = currentConfig.token;
}

function addRecord(dnsConfig, zoneName, name, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(Array.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug(`add: ${name} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    var data = {
        host: name,
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

function updateRecord(dnsConfig, zoneName, recordId, name, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof recordId, 'number');
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(Array.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug(`update:${recordId} on ${name} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    var data = {
        host: name,
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

function getInternal(dnsConfig, zoneName, name, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`getInternal: ${name} in zone ${zoneName} of type ${type}`);

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
                return (r.host === name && r.type === type);
            });

            debug('getInternal: %j', results);

            return callback(null, results);
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

    debug(`upsert: ${name} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    getInternal(dnsConfig, zoneName, name, type, function (error, result) {
        if (error) return callback(error);

        if (result.length === 0) return addRecord(dnsConfig, zoneName, name, type, values, callback);

        return updateRecord(dnsConfig, zoneName, result[0].id, name, type, values, callback);
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

        var tmp = result.map(function (record) { return record.answer; });

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

    debug(`del: ${name} in zone ${zoneName} of type ${type} with values ${JSON.stringify(values)}`);

    getInternal(dnsConfig, zoneName, name, type, function (error, result) {
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

    if (typeof dnsConfig.username !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'username must be a string'));
    if (typeof dnsConfig.token !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'token must be a string'));

    var credentials = {
        username: dnsConfig.username,
        token: dnsConfig.token
    };

    const ip = '127.0.0.1';

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        if (!nameservers.every(function (n) { return n.toLowerCase().indexOf('.name.com') !== -1; })) {
            debug('verifyDnsConfig: %j does not contain Name.com NS', nameservers);
            return callback(new DomainsError(DomainsError.BAD_FIELD, 'Domain nameservers are not set to Name.com'));
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
