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
    debug = require('debug')('box:dns/gcdns'),
    dns = require('../native-dns.js'),
    domains = require('../domains.js'),
    DomainsError = require('../domains.js').DomainsError,
    GCDNS = require('@google-cloud/dns'),
    util = require('util'),
    waitForDns = require('./waitfordns.js'),
    _ = require('underscore');

function removePrivateFields(domainObject) {
    domainObject.config.credentials.private_key = domains.SECRET_PLACEHOLDER;
    return domainObject;
}

function getDnsCredentials(dnsConfig) {
    assert.strictEqual(typeof dnsConfig, 'object');

    return {
        projectId: dnsConfig.projectId,
        credentials: {
            client_email: dnsConfig.credentials.client_email,
            private_key: dnsConfig.credentials.private_key
        }
    };
}

function getZoneByName(dnsConfig, zoneName, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof callback, 'function');

    var gcdns = GCDNS(getDnsCredentials(dnsConfig));

    gcdns.getZones(function (error, zones) {
        if (error && error.message === 'invalid_grant') return callback(new DomainsError(DomainsError.ACCESS_DENIED, 'The key was probably revoked'));
        if (error && error.reason === 'No such domain') return callback(new DomainsError(DomainsError.NOT_FOUND, error.message));
        if (error && error.code === 403) return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
        if (error && error.code === 404) return callback(new DomainsError(DomainsError.NOT_FOUND, error.message));
        if (error) {
            debug('gcdns.getZones', error);
            return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error));
        }

        var zone = zones.filter(function (zone) {
            return zone.metadata.dnsName.slice(0, -1) === zoneName;     // the zone name contains a '.' at the end
        })[0];

        if (!zone) return callback(new DomainsError(DomainsError.NOT_FOUND, 'no such zone'));

        callback(null, zone); //zone.metadata ~= {name="", dnsName="", nameServers:[]}
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
        fqdn = domains.fqdn(location, domainObject);

    debug('add: %s for zone %s of type %s with values %j', fqdn, zoneName, type, values);

    getZoneByName(getDnsCredentials(dnsConfig), zoneName, function (error, zone) {
        if (error) return callback(error);

        zone.getRecords({ type: type, name: fqdn + '.' }, function (error, oldRecords) {
            if (error && error.code === 403) return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
            if (error) {
                debug('upsert->zone.getRecords', error);
                return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error.message));
            }

            var newRecord = zone.record(type, {
                name: fqdn + '.',
                data: values,
                ttl: 1
            });

            zone.createChange({ delete: oldRecords, add: newRecord }, function(error /*, change */) {
                if (error && error.code === 403) return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
                if (error && error.code === 412) return callback(new DomainsError(DomainsError.STILL_BUSY, error.message));
                if (error) {
                    debug('upsert->zone.createChange', error);
                    return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error.message));
                }

                callback(null);
            });
        });
    });
}

function get(domainObject, location, type, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    const dnsConfig = domainObject.config,
        zoneName = domainObject.zoneName,
        fqdn = domains.fqdn(location, domainObject);

    getZoneByName(getDnsCredentials(dnsConfig), zoneName, function (error, zone) {
        if (error) return callback(error);

        var params = {
            name: fqdn + '.',
            type: type
        };

        zone.getRecords(params, function (error, records) {
            if (error && error.code === 403) return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
            if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error));
            if (records.length === 0) return callback(null, [ ]);

            return callback(null, records[0].data);
        });
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
        fqdn = domains.fqdn(location, domainObject);

    getZoneByName(getDnsCredentials(dnsConfig), zoneName, function (error, zone) {
        if (error) return callback(error);

        zone.getRecords({ type: type, name: fqdn + '.' }, function(error, oldRecords) {
            if (error && error.code === 403) return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
            if (error) {
                debug('del->zone.getRecords', error);
                return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error.message));
            }

            zone.deleteRecords(oldRecords, function (error, change) {
                if (error && error.code === 403) return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
                if (error && error.code === 412) return callback(new DomainsError(DomainsError.STILL_BUSY, error.message));
                if (error) {
                    debug('del->zone.createChange', error);
                    return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error.message));
                }

                callback(null, change.id);
            });
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

    if (typeof dnsConfig.projectId !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'projectId must be a string'));
    if (!dnsConfig.credentials || typeof dnsConfig.credentials !== 'object') return callback(new DomainsError(DomainsError.BAD_FIELD, 'credentials must be an object'));
    if (typeof dnsConfig.credentials.client_email !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'credentials.client_email must be a string'));
    if (typeof dnsConfig.credentials.private_key !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'credentials.private_key must be a string'));

    var credentials = getDnsCredentials(dnsConfig);

    const ip = '127.0.0.1';

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        getZoneByName(credentials, zoneName, function (error, zone) {
            if (error) return callback(error);

            var definedNS = zone.metadata.nameServers.sort().map(function(r) { return r.replace(/\.$/, ''); });
            if (!_.isEqual(definedNS, nameservers.sort())) {
                debug('verifyDnsConfig: %j and %j do not match', nameservers, definedNS);
                return callback(new DomainsError(DomainsError.BAD_FIELD, 'Domain nameservers are not set to Google Cloud DNS'));
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
    });
}
