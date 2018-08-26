'use strict';

exports = module.exports = {
    upsert: upsert,
    get: get,
    del: del,
    waitForDns: require('./waitfordns.js'),
    verifyDnsConfig: verifyDnsConfig,

    // not part of "dns" interface
    getHostedZone: getHostedZone
};

var assert = require('assert'),
    AWS = require('aws-sdk'),
    debug = require('debug')('box:dns/route53'),
    dns = require('../native-dns.js'),
    DomainsError = require('../domains.js').DomainsError,
    util = require('util'),
    _ = require('underscore');

function getDnsCredentials(dnsConfig) {
    assert.strictEqual(typeof dnsConfig, 'object');

    var credentials = {
        accessKeyId: dnsConfig.accessKeyId,
        secretAccessKey: dnsConfig.secretAccessKey,
        region: dnsConfig.region
    };

    if (dnsConfig.endpoint) credentials.endpoint = new AWS.Endpoint(dnsConfig.endpoint);

    return credentials;
}

function getZoneByName(dnsConfig, zoneName, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof callback, 'function');

    var route53 = new AWS.Route53(getDnsCredentials(dnsConfig));

    // backward compat for 2.2, where we only required access to "listHostedZones"
    let listHostedZones;
    if (dnsConfig.listHostedZonesByName) {
        listHostedZones = route53.listHostedZonesByName.bind(route53, { MaxItems: '1', DNSName: zoneName + '.' });
    } else {
        listHostedZones = route53.listHostedZones.bind(route53, {}); // currently, this route does not support > 100 zones
    }

    listHostedZones(function (error, result) {
        if (error && error.code === 'AccessDenied') return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
        if (error && error.code === 'InvalidClientTokenId') return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
        if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error.message));

        var zone = result.HostedZones.filter(function (zone) {
            return zone.Name.slice(0, -1) === zoneName;     // aws zone name contains a '.' at the end
        })[0];

        if (!zone) return callback(new DomainsError(DomainsError.NOT_FOUND, 'no such zone'));

        callback(null, zone);
    });
}

function getHostedZone(dnsConfig, zoneName, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof callback, 'function');

    getZoneByName(dnsConfig, zoneName, function (error, zone) {
        if (error) return callback(error);

        var route53 = new AWS.Route53(getDnsCredentials(dnsConfig));
        route53.getHostedZone({ Id: zone.Id }, function (error, result) {
            if (error && error.code === 'AccessDenied') return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
            if (error && error.code === 'InvalidClientTokenId') return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
            if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error.message));

            callback(null, result);
        });
    });
}

function add(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug('add: %s for zone %s of type %s with values %j', subdomain, zoneName, type, values);

    getZoneByName(dnsConfig, zoneName, function (error, zone) {
        if (error) return callback(error);

        var fqdn = subdomain === '' ? zoneName : subdomain + '.' + zoneName;
        var records = values.map(function (v) { return { Value: v }; });  // for mx records, value is already of the '<priority> <server>' format

        var params = {
            ChangeBatch: {
                Changes: [{
                    Action: 'UPSERT',
                    ResourceRecordSet: {
                        Type: type,
                        Name: fqdn,
                        ResourceRecords: records,
                        TTL: 1
                    }
                }]
            },
            HostedZoneId: zone.Id
        };

        var route53 = new AWS.Route53(getDnsCredentials(dnsConfig));
        route53.changeResourceRecordSets(params, function(error) {
            if (error && error.code === 'AccessDenied') return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
            if (error && error.code === 'InvalidClientTokenId') return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
            if (error && error.code === 'PriorRequestNotComplete') return callback(new DomainsError(DomainsError.STILL_BUSY, error.message));
            if (error && error.code === 'InvalidChangeBatch') return callback(new DomainsError(DomainsError.BAD_FIELD, error.message));
            if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error.message));

            callback(null);
        });
    });
}

function upsert(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    add(dnsConfig, zoneName, subdomain, type, values, callback);
}

function get(dnsConfig, zoneName, subdomain, type, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    getZoneByName(dnsConfig, zoneName, function (error, zone) {
        if (error) return callback(error);

        var params = {
            HostedZoneId: zone.Id,
            MaxItems: '1',
            StartRecordName: (subdomain ? subdomain + '.' : '') + zoneName + '.',
            StartRecordType: type
        };

        var route53 = new AWS.Route53(getDnsCredentials(dnsConfig));
        route53.listResourceRecordSets(params, function (error, result) {
            if (error && error.code === 'AccessDenied') return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
            if (error && error.code === 'InvalidClientTokenId') return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
            if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error.message));
            if (result.ResourceRecordSets.length === 0) return callback(null, [ ]);
            if (result.ResourceRecordSets[0].Name !== params.StartRecordName || result.ResourceRecordSets[0].Type !== params.StartRecordType) return callback(null, [ ]);

            var values = result.ResourceRecordSets[0].ResourceRecords.map(function (record) { return record.Value; });

            callback(null, values);
        });
    });
}

function del(dnsConfig, zoneName, subdomain, type, values, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    getZoneByName(dnsConfig, zoneName, function (error, zone) {
        if (error) return callback(error);

        var fqdn = subdomain === '' ? zoneName : subdomain + '.' + zoneName;
        var records = values.map(function (v) { return { Value: v }; });

        var resourceRecordSet = {
            Name: fqdn,
            Type: type,
            ResourceRecords: records,
            TTL: 1
        };

        var params = {
            ChangeBatch: {
                Changes: [{
                    Action: 'DELETE',
                    ResourceRecordSet: resourceRecordSet
                }]
            },
            HostedZoneId: zone.Id
        };

        var route53 = new AWS.Route53(getDnsCredentials(dnsConfig));
        route53.changeResourceRecordSets(params, function(error) {
            if (error && error.code === 'AccessDenied') return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
            if (error && error.code === 'InvalidClientTokenId') return callback(new DomainsError(DomainsError.ACCESS_DENIED, error.message));
            if (error && error.message && error.message.indexOf('it was not found') !== -1) {
                debug('del: resource record set not found.', error);
                return callback(new DomainsError(DomainsError.NOT_FOUND, error.message));
            } else if (error && error.code === 'NoSuchHostedZone') {
                debug('del: hosted zone not found.', error);
                return callback(new DomainsError(DomainsError.NOT_FOUND, error.message));
            } else if (error && error.code === 'PriorRequestNotComplete') {
                debug('del: resource is still busy', error);
                return callback(new DomainsError(DomainsError.STILL_BUSY, error.message));
            } else if (error && error.code === 'InvalidChangeBatch') {
                debug('del: invalid change batch. No such record to be deleted.');
                return callback(new DomainsError(DomainsError.NOT_FOUND, error.message));
            } else if (error) {
                debug('del: error', error);
                return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error.message));
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

    if (!dnsConfig.accessKeyId || typeof dnsConfig.accessKeyId !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'accessKeyId must be a non-empty string'));
    if (!dnsConfig.secretAccessKey || typeof dnsConfig.secretAccessKey !== 'string') return callback(new DomainsError(DomainsError.BAD_FIELD, 'secretAccessKey must be a non-empty string'));
    if ('hyphenatedSubdomains' in dnsConfig && typeof dnsConfig.hyphenatedSubdomains !== 'boolean') return callback(new DomainsError(DomainsError.BAD_FIELD, 'hyphenatedSubdomains must be a boolean'));

    var credentials = {
        accessKeyId: dnsConfig.accessKeyId,
        secretAccessKey: dnsConfig.secretAccessKey,
        region: dnsConfig.region || 'us-east-1',
        endpoint: dnsConfig.endpoint || null,
        listHostedZonesByName: true, // new/updated creds require this perm
        hyphenatedSubdomains: !!dnsConfig.hyphenatedSubdomains
    };

    if (process.env.BOX_ENV === 'test') return callback(null, credentials); // this shouldn't be here

    dns.resolve(zoneName, 'NS', { timeout: 5000 }, function (error, nameservers) {
        if (error && error.code === 'ENOTFOUND') return callback(new DomainsError(DomainsError.BAD_FIELD, 'Unable to resolve nameservers for this domain'));
        if (error || !nameservers) return callback(new DomainsError(DomainsError.BAD_FIELD, error ? error.message : 'Unable to get nameservers'));

        getHostedZone(credentials, zoneName, function (error, zone) {
            if (error) return callback(error);

            if (!_.isEqual(zone.DelegationSet.NameServers.sort(), nameservers.sort())) {
                debug('verifyDnsConfig: %j and %j do not match', nameservers, zone.DelegationSet.NameServers);
                return callback(new DomainsError(DomainsError.BAD_FIELD, 'Domain nameservers are not set to Route53'));
            }

            const testSubdomain = 'cloudrontestdns';

            upsert(credentials, zoneName, testSubdomain, 'A', [ ip ], function (error, changeId) {
                if (error) return callback(error);

                debug('verifyDnsConfig: Test A record added with change id %s', changeId);

                del(credentials, zoneName, testSubdomain, 'A', [ ip ], function (error) {
                    if (error) return callback(error);

                    debug('verifyDnsConfig: Test A record removed again');

                    callback(null, credentials);
                });
            });
        });
    });
}
