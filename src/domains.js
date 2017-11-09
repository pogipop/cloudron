'use strict';

module.exports = exports = {
    add: add,
    get: get,
    getAll: getAll,
    update: update,
    del: del,

    getDNSRecords: getDNSRecords,
    upsertDNSRecords: upsertDNSRecords,
    removeDNSRecords: removeDNSRecords,

    waitForDNSRecord: waitForDNSRecord,

    DomainError: DomainError
};

var assert = require('assert'),
    certificates = require('./certificates.js'),
    DatabaseError = require('./databaseerror.js'),
    domaindb = require('./domaindb.js'),
    sysinfo = require('./sysinfo.js'),
    tld = require('tldjs'),
    util = require('util');

function DomainError(reason, errorOrMessage) {
    assert.strictEqual(typeof reason, 'string');
    assert(errorOrMessage instanceof Error || typeof errorOrMessage === 'string' || typeof errorOrMessage === 'undefined');

    Error.call(this);
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name;
    this.reason = reason;
    if (typeof errorOrMessage === 'undefined') {
        this.message = reason;
    } else if (typeof errorOrMessage === 'string') {
        this.message = errorOrMessage;
    } else {
        this.message = 'Internal error';
        this.nestedError = errorOrMessage;
    }
}
util.inherits(DomainError, Error);

DomainError.NOT_FOUND = 'No such domain';
DomainError.ALREADY_EXISTS = 'Domain already exists';
DomainError.EXTERNAL_ERROR = 'External error';
DomainError.BAD_FIELD = 'Bad Field';
DomainError.STILL_BUSY = 'Still busy';
DomainError.INTERNAL_ERROR = 'Internal error';
DomainError.ACCESS_DENIED = 'Access denied';
DomainError.INVALID_PROVIDER = 'provider must be route53, gcdns, digitalocean, cloudflare, noop, manual or caas';

// choose which subdomain backend we use for test purpose we use route53
function api(provider) {
    assert.strictEqual(typeof provider, 'string');

    switch (provider) {
        case 'caas': return require('./dns/caas.js');
        case 'cloudflare': return require('./dns/cloudflare.js');
        case 'route53': return require('./dns/route53.js');
        case 'gcdns': return require('./dns/gcdns.js');
        case 'digitalocean': return require('./dns/digitalocean.js');
        case 'noop': return require('./dns/noop.js');
        case 'manual': return require('./dns/manual.js');
        default: return null;
    }
}

// TODO make it return a DomainError instead of DomainError
function verifyDnsConfig(config, domain, zoneName, ip, callback) {
    assert(config && typeof config === 'object'); // the dns config to test with
    assert(typeof config.provider === 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    var backend = api(config.provider);
    if (!backend) return callback(new DomainError(DomainError.INVALID_PROVIDER));

    api(config.provider).verifyDnsConfig(config, domain, zoneName, ip, callback);
}


function add(domain, zoneName, config, fallbackCertificate, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof fallbackCertificate, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!tld.isValid(domain)) return callback(new DomainError(DomainError.BAD_FIELD, 'Invalid domain'));
    if (!tld.isValid(zoneName)) return callback(new DomainError(DomainError.BAD_FIELD, 'Invalid zoneName'));

    if (fallbackCertificate) {
        let error = certificates.validateCertificate(fallbackCertificate.cert, fallbackCertificate.key, domain);
        if (error) return callback(new DomainError(DomainError.BAD_FIELD, error.message));
    }

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, 'Error getting IP:' + error.message));

        verifyDnsConfig(config, domain, zoneName, ip, function (error, result) {
            if (error && error.reason === DomainError.ACCESS_DENIED) return callback(new DomainError(DomainError.BAD_FIELD, 'Error adding A record. Access denied'));
            if (error && error.reason === DomainError.NOT_FOUND) return callback(new DomainError(DomainError.BAD_FIELD, 'Zone not found'));
            if (error && error.reason === DomainError.EXTERNAL_ERROR) return callback(new DomainError(DomainError.BAD_FIELD, 'Error adding A record:' + error.message));
            if (error && error.reason === DomainError.BAD_FIELD) return callback(new DomainError(DomainError.BAD_FIELD, error.message));
            if (error && error.reason === DomainError.INVALID_PROVIDER) return callback(new DomainError(DomainError.BAD_FIELD, error.message));
            if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

            domaindb.add(domain, zoneName, result, function (error) {
                if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new DomainError(DomainError.ALREADY_EXISTS));
                if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

                if (!fallbackCertificate) return callback();

                // cert validation already happened above no need to check all errors again
                certificates.setFallbackCertificate(fallbackCertificate.cert, fallbackCertificate.key, domain, function (error) {
                    if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));
                    callback();
                });
            });
        });
    });
}

function get(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    domaindb.get(domain, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainError(DomainError.NOT_FOUND));
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    domaindb.getAll(function (error, result) {
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function update(domain, config, fallbackCertificate, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof fallbackCertificate, 'object');
    assert.strictEqual(typeof callback, 'function');

    domaindb.get(domain, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainError(DomainError.NOT_FOUND));
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        if (fallbackCertificate) {
            let error = certificates.validateCertificate(fallbackCertificate.cert, fallbackCertificate.key, domain);
            if (error) return callback(new DomainError(DomainError.BAD_FIELD, error.message));
        }

        sysinfo.getPublicIp(function (error, ip) {
            if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, 'Error getting IP:' + error.message));

            verifyDnsConfig(config, domain, result.zoneName, ip, function (error, result) {
                if (error && error.reason === DomainError.ACCESS_DENIED) return callback(new DomainError(DomainError.BAD_FIELD, 'Error adding A record. Access denied'));
                if (error && error.reason === DomainError.NOT_FOUND) return callback(new DomainError(DomainError.BAD_FIELD, 'Zone not found'));
                if (error && error.reason === DomainError.EXTERNAL_ERROR) return callback(new DomainError(DomainError.BAD_FIELD, 'Error adding A record:' + error.message));
                if (error && error.reason === DomainError.BAD_FIELD) return callback(new DomainError(DomainError.BAD_FIELD, error.message));
                if (error && error.reason === DomainError.INVALID_PROVIDER) return callback(new DomainError(DomainError.BAD_FIELD, error.message));
                if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

                domaindb.update(domain, result, function (error) {
                    if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainError(DomainError.NOT_FOUND));
                    if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

                    if (!fallbackCertificate) return callback();

                    // cert validation already happened above no need to check all errors again
                    certificates.setFallbackCertificate(fallbackCertificate.cert, fallbackCertificate.key, domain, function (error) {
                        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));
                        callback();
                    });
                });
            });
        });
    });
}

function del(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    // TODO check if domain is still used by an app

    domaindb.del(domain, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainError(DomainError.NOT_FOUND));
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function getDNSRecords(fqdn, type, callback) {
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    const domain = tld.getDomain(fqdn);
    const subdomain = tld.getSubdomain(fqdn);

    get(domain, function (error, result) {
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        api(result.config.provider).get(result.config, result.zoneName, subdomain, type, function (error, values) {
            if (error) return callback(error);

            callback(null, values);
        });
    });
}

function upsertDNSRecords(fqdn, type, values, callback) {
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    const domain = tld.getDomain(fqdn);
    const subdomain = tld.getSubdomain(fqdn);

    get(domain, function (error, result) {
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        api(result.config.provider).upsert(result.config, result.zoneName, subdomain, type, values, function (error, changeId) {
            if (error) return callback(error);

            callback(null, changeId);
        });
    });
}

function removeDNSRecords(fqdn, type, values, callback) {
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    const domain = tld.getDomain(fqdn);
    const subdomain = tld.getSubdomain(fqdn);

    get(domain, function (error, result) {
        if (error) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        api(result.config.provider).del(result.config, result.zoneName, subdomain, type, values, function (error) {
            if (error && error.reason !== DomainError.NOT_FOUND) return callback(error);

            callback(null);
        });
    });
}

function waitForDNSRecord(fqdn, value, type, options, callback) {
    assert.strictEqual(typeof fqdn, 'string');
    assert(typeof value === 'string' || util.isRegExp(value));
    assert(type === 'A' || type === 'CNAME' || type === 'TXT');
    assert(options && typeof options === 'object'); // { interval: 5000, times: 50000 }
    assert.strictEqual(typeof callback, 'function');

    const domain = tld.getDomain(fqdn);

    get(domain, function (error, result) {
        if (error && error.reason !== DomainError.NOT_FOUND) return callback(new DomainError(DomainError.INTERNAL_ERROR, error));

        // if the domain is on another zone in case of external domain, use the correct zone
        const zoneName = result ? result.zoneName : tld.getDomain(domain);
        const provider = result ? result.config.provider : 'manual';

        api(provider).waitForDns(fqdn, zoneName, value, type, options, callback);
    });
}