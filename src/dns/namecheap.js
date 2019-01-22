'use strict';

exports = module.exports = {
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
    Namecheap = require('namecheap'),
    sysinfo = require('../sysinfo.js'),
    util = require('util'),
    waitForDns = require('./waitfordns.js');

var namecheap;

function formatError(response) {
    return util.format('NameCheap DNS error [%s] %j', response.code, response.message);
}

// The keys that NameCheap returns us and the keys we need to provide it differ, so we need to map them properly
function mapHosts(hosts) {
    for (var i = 0; i < hosts.length; i++) {
        let curHost = hosts[i];
        if (curHost.Name && !curHost.HostName) {
            curHost.HostName = curHost.Name;
            delete curHost.Name;
        }

        if (curHost.Type && !curHost.RecordType) {
            curHost.RecordType = curHost.Type;
            delete curHost.Type;
        }
    }

    return hosts;
}

function init(dnsConfig, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (namecheap) return callback();

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        // Note that for all NameCheap calls to go through properly, the public IP returned by the getPublicIp method below must be whitelisted on NameCheap's API dashboard
        namecheap = new Namecheap(dnsConfig.username, dnsConfig.apiKey, ip);
        namecheap.setUsername(dnsConfig.username);

        callback();
    });
}

function getInternal(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    init(dnsConfig, function (error) {
        if (error) return callback(error);

        namecheap.domains.dns.getHosts(zoneName, function (error, result) {
            if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(error)));

            debug('entire getInternal response: %j', error);

            return callback(null, result['DomainDNSGetHostsResult']['host']);
        });
    });
}

function setInternal(zoneName, hosts, callback) {
    let mappedHosts = mapHosts(hosts);
    namecheap.domains.dns.setHosts(zoneName, mappedHosts, function (error, result) {
        if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, formatError(error)));

        return callback(null, result);
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

        setInternal(zoneName, toUpsert, callback);
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
        if (removed) return setInternal(zoneName, result, callback);

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
    if (!dnsConfig.apiKey || typeof dnsConfig.apiKey !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'apiKey must be a non-empty string'));

    var credentials = {
        username: dnsConfig.username,
        apKey: dnsConfig.apiKey
    };

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

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

                callback(null, dnsConfig);
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
