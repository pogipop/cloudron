'use strict';

exports = module.exports = {
    removePrivateFields: removePrivateFields,
    injectPrivateFields: injectPrivateFields,
    upsert: upsert,
    get: get,
    del: del,
    verifyDnsConfig: verifyDnsConfig,
    wait: wait
};

var assert = require('assert'),
    debug = require('debug')('box:dns/namecheap'),
    dns = require('../native-dns.js'),
    domains = require('../domains.js'),
    DomainsError = require('../domains.js').DomainsError,
    safe = require('safetydance'),
    superagent = require('superagent'),
    sysinfo = require('../sysinfo.js'),
    util = require('util'),
    waitForDns = require('./waitfordns.js'),
    xml2js = require('xml2js');

const ENDPOINT = 'https://api.namecheap.com/xml.response';

function removePrivateFields(domainObject) {
    domainObject.config.token = domains.SECRET_PLACEHOLDER;
    return domainObject;
}

function injectPrivateFields(newConfig, currentConfig) {
    if (newConfig.token === domains.SECRET_PLACEHOLDER) newConfig.token = currentConfig.token;
}

function getQuery(dnsConfig, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        callback(null, {
            ApiUser: dnsConfig.username,
            ApiKey: dnsConfig.token,
            UserName: dnsConfig.username,
            ClientIp: ip
        });
    });
}

function getInternal(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    getQuery(dnsConfig, function (error, query) {
        if (error) return callback(error);

        query.Command = 'namecheap.domains.dns.getHosts';
        query.SLD = zoneName.split('.')[0];
        query.TLD = zoneName.split('.')[1];

        superagent.get(ENDPOINT).query(query).end(function (error, result) {
            if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error));

            var parser = new xml2js.Parser();
            parser.parseString(result.text, function (error, result) {
                if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error));

                var tmp = result.ApiResponse;
                if (tmp['$'].Status !== 'OK') return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, safe.query(tmp, 'Errors[0].Error[0]._', 'Invalid response')));
                if (!tmp.CommandResponse[0]) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, 'Invalid response'));
                if (!tmp.CommandResponse[0].DomainDNSGetHostsResult[0]) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, 'Invalid response'));

                var hosts = result.ApiResponse.CommandResponse[0].DomainDNSGetHostsResult[0].host.map(function (h) {
                    return h['$'];
                });

                callback(null, hosts);
            });
        });
    });
}

function setInternal(dnsConfig, zoneName, hosts, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert(Array.isArray(hosts));
    assert.strictEqual(typeof callback, 'function');

    getQuery(dnsConfig, function (error, query) {
        if (error) return callback(error);

        query.Command = 'namecheap.domains.dns.setHosts';
        query.SLD = zoneName.split('.')[0];
        query.TLD = zoneName.split('.')[1];

        // Map to query params https://www.namecheap.com/support/api/methods/domains-dns/set-hosts.aspx
        hosts.forEach(function (host, i) {
            var n = i+1; // api starts with 1 not 0
            query['TTL' + n] = '300'; // keep it low
            query['HostName' + n] = host.HostName || host.Name;
            query['RecordType' + n] = host.RecordType || host.Type;
            query['Address' + n] = host.Address;

            if (host.Type === 'MX') {
                query['EmailType' + n] = 'MX';
                if (host.MXPref) query['MXPref' + n] = host.MXPref;
            }
        });

        superagent.post(ENDPOINT).query(query).end(function (error, result) {
            if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error));

            var parser = new xml2js.Parser();
            parser.parseString(result.text, function (error, result) {
                if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error));

                var tmp = result.ApiResponse;
                if (tmp['$'].Status !== 'OK') return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, safe.query(tmp, 'Errors[0].Error[0]._', 'Invalid response')));
                if (!tmp.CommandResponse[0]) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, 'Invalid response'));
                if (!tmp.CommandResponse[0].DomainDNSSetHostsResult[0]) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, 'Invalid response'));
                if (tmp.CommandResponse[0].DomainDNSSetHostsResult[0]['$'].IsSuccess !== 'true') return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, 'Invalid response'));

                callback(null);
            });
        });
    });
}

function upsert(domainObject, subdomain, type, values, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    const dnsConfig = domainObject.config;
    const zoneName = domainObject.zoneName;

    subdomain = domains.getName(domainObject, subdomain, type) || '@';

    debug('upsert: %s for zone %s of type %s with values %j', subdomain, zoneName, type, values);

    getInternal(dnsConfig, zoneName, subdomain, type, function (error, result) {
        if (error) return callback(error);

        // Array to keep track of records that need to be inserted
        let toInsert = [];

        for (var i = 0; i < values.length; i++) {
            let curValue = values[i];
            let wasUpdate = false;

            for (var j = 0; j < result.length; j++) {
                let curHost = result[j];

                if (curHost.Type === type && curHost.Name === subdomain) {
                    // Updating an already existing host
                    wasUpdate = true;
                    if (type === 'MX') {
                        curHost.MXPref = curValue.split(' ')[0];
                        curHost.Address = curValue.split(' ')[1];
                    } else {
                        curHost.Address = curValue;
                    }
                }
            }

            // We don't have this host at all yet, let's push to toInsert array
            if (!wasUpdate) {
                let newRecord = {
                    RecordType: type,
                    HostName: subdomain,
                    Address: curValue
                };

                // Special case for MX records
                if (type === 'MX') {
                    newRecord.MXPref = curValue.split(' ')[0];
                    newRecord.Address = curValue.split(' ')[1];
                }

                toInsert.push(newRecord);

            }
        }

        let toUpsert = result.concat(toInsert);

        setInternal(dnsConfig, zoneName, toUpsert, callback);
    });
}

function get(domainObject, subdomain, type, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    const dnsConfig = domainObject.config;
    const zoneName = domainObject.zoneName;

    subdomain = domains.getName(domainObject, subdomain, type) || '@';

    getInternal(dnsConfig, zoneName, subdomain, type, function (error, result) {
        if (error) return callback(error);

        // We need to filter hosts to ones with this subdomain and type
        let actualHosts = result.filter((host) => host.Type === type && host.Name === subdomain);

        // We only return the value string
        var tmp = actualHosts.map(function (record) { return record.Address; });

        debug('get: %j', tmp);

        return callback(null, tmp);
    });
}

function del(domainObject, subdomain, type, values, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    const dnsConfig = domainObject.config;
    const zoneName = domainObject.zoneName;

    subdomain = domains.getName(domainObject, subdomain, type) || '@';

    debug('del: %s for zone %s of type %s with values %j', subdomain, zoneName, type, values);

    getInternal(dnsConfig, zoneName, subdomain, type, function (error, result) {
        if (error) return callback(error);

        if (result.length === 0) return callback();

        let removed = false;

        for (var i = 0; i < values.length; i++) {
            let curValue = values[i];

            for (var j = 0; j < result.length; j++) {
                let curHost = result[i];

                if (curHost.Type === type && curHost.Name === subdomain && curHost.Address === curValue) {
                    removed = true;

                    result.splice(i, 1); // Remove element from result array
                }
            }
        }

        // Only set hosts if we actually removed a host
        if (removed) return setInternal(dnsConfig, zoneName, result, callback);

        callback();
    });
}

function verifyDnsConfig(domainObject, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof callback, 'function');

    const dnsConfig = domainObject.config;
    const zoneName = domainObject.zoneName;
    const ip = '127.0.0.1';

    if (!dnsConfig.username || typeof dnsConfig.username !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'username must be a non-empty string'));
    if (!dnsConfig.token || typeof dnsConfig.token !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'token must be a non-empty string'));

    let credentials = {
        username: dnsConfig.username,
        token: dnsConfig.token
    };

    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        if (nameservers.some(function (n) { return n.toLowerCase().indexOf('.registrar-servers.com') === -1; })) {
            debug('verifyDnsConfig: %j does not contains NC NS', nameservers);
            return callback(new DomainsError(DomainsError.BAD_FIELD, 'Domain nameservers are not set to NameCheap'));
        }

        const testSubdomain = 'cloudrontestdns';

        upsert(domainObject, testSubdomain, 'A', [ip], function (error, changeId) {
            if (error) return callback(error);

            debug('verifyDnsConfig: Test A record added with change id %s', changeId);

            del(domainObject, testSubdomain, 'A', [ip], function (error) {
                if (error) return callback(error);

                debug('verifyDnsConfig: Test A record removed again');

                callback(null, credentials);
            });
        });
    });
}

function wait(domainObject, subdomain, type, value, options, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof value, 'string');
    assert(options && typeof options === 'object'); // { interval: 5000, times: 50000 }
    assert.strictEqual(typeof callback, 'function');

    const fqdn = domains.fqdn(subdomain, domainObject);

    waitForDns(fqdn, domainObject.zoneName, type, value, options, callback);
}
