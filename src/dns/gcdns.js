'use strict';

exports = module.exports = {
    upsert: upsert,
    get: get,
    del: del,
    waitForDns: require('./waitfordns.js'),
    verifyDnsConfig: verifyDnsConfig
};

var assert = require('assert'),
    GCDNS = require('@google-cloud/dns'),
    constants = require('../constants.js'),
    debug = require('debug')('box:dns/gcdns'),
    dns = require('dns'),
    SubdomainError = require('../subdomains.js').SubdomainError,
    util = require('util'),
    _ = require('underscore');

function getDnsCredentials(dnsConfig) {
    assert.strictEqual(typeof dnsConfig, 'object');

    var config = {
        provider: dnsConfig.provider,
        projectId: dnsConfig.projectId,
        keyFilename: dnsConfig.keyFilename,
        email: dnsConfig.email
    };

    if(dnsConfig.credentials){
        config.credentials = {
            client_email: dnsConfig.credentials.client_email,
            private_key: dnsConfig.credentials.private_key
        };
    }
    return config;
}

function getZoneByName(dnsConfig, zoneName, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof callback, 'function');

    var gcdns = GCDNS(getDnsCredentials(dnsConfig));

    gcdns.getZones(function(err, zones, apiResponse) {
        if (err && err.message == 'invalid_grant') return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, "The key was probably revoked"));
        if (err && err.reason == 'No such domain') return callback(new SubdomainError(SubdomainError.NOT_FOUND, err.message));
        if (err && err.code == 403) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, err.message));
        if (err && err.code == 404) return callback(new SubdomainError(SubdomainError.NOT_FOUND, err.message));
        if (err) {
            debug('gcdns.getZones', err);
            return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, err));
        }

        var zone = zones.filter(function (zone) {
            return zone.metadata.dnsName.slice(0, -1) === zoneName;     // the zone name contains a '.' at the end
        })[0];

        if (!zone) return callback(new SubdomainError(SubdomainError.NOT_FOUND, 'no such zone'));

        callback(null, zone); //zone.metadata ~= {name="", dnsName="", nameServers:[]}
    });
}

function upsert(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug('add: %s for zone %s of type %s with values %j', subdomain, zoneName, type, values);

    getZoneByName(getDnsCredentials(dnsConfig), zoneName, function (error, zone) {
        if (error) return callback(error);

        var params = zone.record(type, {
            name: (subdomain ? subdomain + '.' : '') + zoneName + '.',
            data: values,
            ttl: 1
        });

        zone.replaceRecords(type, [params], function(error, change, apiResponse) {
            if (error && error.code == 403) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, error.message));
            if (error) {
                debug('zone.replaceRecords', error);
                return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, error.message));
            }

            callback(null, change.id);
        });
    });
}

function get(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    getZoneByName(getDnsCredentials(dnsConfig), zoneName, function (error, zone) {
        if (error) return callback(error);

        var params = {
            name: (subdomain ? subdomain + '.' : '') + zoneName + '.',
            type: type
        };

        var allValues = [];
        var recursiveRetriever = function(err, records, nextQuery, apiResponse) {
            if (err) {
                if (error && error.code == 403) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, error.message));
                if (error) return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, error));
            }
            if (records.length > 0) {
                allValues = allValues.concat(records[0].data);
            }
            if (nextQuery) {
                return zone.getRecords(nextQuery, recursiveRetriever);
            }

            callback(null, allValues);
        };
        zone.getRecords(params, recursiveRetriever);
    });
}

function del(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    getZoneByName(getDnsCredentials(dnsConfig), zoneName, function (error, zone) {
        if (error) return callback(error);

        var rec = zone.record('a', {
            name: (subdomain ? subdomain + '.' : '') + zoneName + '.',
            data: values,
            ttl: 1
        });

        zone.deleteRecords(rec, function(error, change, apiResponse) {
            if (error && error.code == 403) return callback(new SubdomainError(SubdomainError.ACCESS_DENIED, error.message));
            if (error) {
                debug('zone.deleteRecords', error);
                return callback(new SubdomainError(SubdomainError.EXTERNAL_ERROR, error));
            }

            callback(null);
        });
    });
}

function verifyDnsConfig(dnsConfig, fqdn, zoneName, ip, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    var credentials = getDnsCredentials(dnsConfig);
    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolveNs(zoneName, function (error, resolvedNS) {
        if (error && error.code === 'ENOTFOUND') return callback(new SubdomainError(SubdomainError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !resolvedNS) return callback(new SubdomainError(SubdomainError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        getZoneByName(credentials, zoneName, function (error, zone) {
            if (error) return callback(error);

            var definedNS = zone.metadata.nameServers.sort().map(function(r){ return r.replace(/\.$/, '')});
            if (!_.isEqual(definedNS, resolvedNS.sort())) {
                debug('verifyDnsConfig: %j and %j do not match', resolvedNS, definedNS);
                return callback(new SubdomainError(SubdomainError.BAD_FIELD, 'Domain nameservers are not set to Google Cloud DNS'));
            }

            const name = constants.ADMIN_LOCATION + (fqdn === zoneName ? '' :  '.' + fqdn.slice(0, - zoneName.length - 1));

            upsert(credentials, zoneName, name, 'A', [ ip ], function (error, changeId) {
                if (error) return callback(error);

                debug('verifyDnsConfig: A record added with change id %s', changeId);

                callback(null, credentials);
            });
        });
    });
}
