'use strict';

module.exports = exports = {
    add: add,
    get: get,
    getAll: getAll,
    update: update,
    del: del,

    fqdn: fqdn,
    setAdmin: setAdmin,

    getDnsRecords: getDnsRecords,
    upsertDnsRecords: upsertDnsRecords,
    removeDnsRecords: removeDnsRecords,

    waitForDnsRecord: waitForDnsRecord,

    removePrivateFields: removePrivateFields,
    removeRestrictedFields: removeRestrictedFields,

    DomainsError: DomainsError
};

var assert = require('assert'),
    caas = require('./caas.js'),
    config = require('./config.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:domains'),
    domaindb = require('./domaindb.js'),
    path = require('path'),
    reverseProxy = require('./reverseproxy.js'),
    ReverseProxyError = reverseProxy.ReverseProxyError,
    safe = require('safetydance'),
    shell = require('./shell.js'),
    sysinfo = require('./sysinfo.js'),
    tld = require('tldjs'),
    util = require('util'),
    _ = require('underscore');

var RESTART_CMD = path.join(__dirname, 'scripts/restart.sh');
var NOOP_CALLBACK = function (error) { if (error) debug(error); };

function DomainsError(reason, errorOrMessage) {
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
util.inherits(DomainsError, Error);

DomainsError.NOT_FOUND = 'No such domain';
DomainsError.ALREADY_EXISTS = 'Domain already exists';
DomainsError.EXTERNAL_ERROR = 'External error';
DomainsError.BAD_FIELD = 'Bad Field';
DomainsError.STILL_BUSY = 'Still busy';
DomainsError.IN_USE = 'In Use';
DomainsError.INTERNAL_ERROR = 'Internal error';
DomainsError.ACCESS_DENIED = 'Access denied';
DomainsError.INVALID_PROVIDER = 'provider must be route53, gcdns, digitalocean, gandi, cloudflare, namecom, noop, manual or caas';

// choose which subdomain backend we use for test purpose we use route53
function api(provider) {
    assert.strictEqual(typeof provider, 'string');

    switch (provider) {
    case 'caas': return require('./dns/caas.js');
    case 'cloudflare': return require('./dns/cloudflare.js');
    case 'route53': return require('./dns/route53.js');
    case 'gcdns': return require('./dns/gcdns.js');
    case 'digitalocean': return require('./dns/digitalocean.js');
    case 'gandi': return require('./dns/gandi.js');
    case 'godaddy': return require('./dns/godaddy.js');
    case 'namecom': return require('./dns/namecom.js');
    case 'noop': return require('./dns/noop.js');
    case 'manual': return require('./dns/manual.js');
    default: return null;
    }
}

function verifyDnsConfig(config, domain, zoneName, provider, ip, callback) {
    assert(config && typeof config === 'object'); // the dns config to test with
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof provider, 'string');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    var backend = api(provider);
    if (!backend) return callback(new DomainsError(DomainsError.INVALID_PROVIDER));

    api(provider).verifyDnsConfig(config, domain, zoneName, ip, callback);
}

function add(domain, zoneName, provider, config, fallbackCertificate, tlsConfig, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof provider, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof fallbackCertificate, 'object');
    assert.strictEqual(typeof tlsConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!tld.isValid(domain)) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Invalid domain'));
    if (domain.endsWith('.')) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Invalid domain'));

    if (zoneName) {
        if (!tld.isValid(zoneName)) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Invalid zoneName'));
        if (zoneName.endsWith('.')) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Invalid zoneName'));
    } else {
        zoneName = tld.getDomain(domain) || domain;
    }

    if (fallbackCertificate) {
        let error = reverseProxy.validateCertificate(`test.${domain}`, fallbackCertificate.cert, fallbackCertificate.key);
        if (error) return callback(new DomainsError(DomainsError.BAD_FIELD, error.message));
    }

    if (tlsConfig.provider !== 'fallback' && tlsConfig.provider !== 'caas' && tlsConfig.provider.indexOf('letsencrypt-') !== 0) {
        return callback(new DomainsError(DomainsError.BAD_FIELD, 'tlsConfig.provider must be caas, fallback or le-*'));
    }

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, 'Error getting IP:' + error.message));

        verifyDnsConfig(config, domain, zoneName, provider, ip, function (error, result) {
            if (error && error.reason === DomainsError.ACCESS_DENIED) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Error adding A record. Access denied'));
            if (error && error.reason === DomainsError.NOT_FOUND) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Zone not found'));
            if (error && error.reason === DomainsError.EXTERNAL_ERROR) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Error adding A record: ' + error.message));
            if (error && error.reason === DomainsError.BAD_FIELD) return callback(new DomainsError(DomainsError.BAD_FIELD, error.message));
            if (error && error.reason === DomainsError.INVALID_PROVIDER) return callback(new DomainsError(DomainsError.BAD_FIELD, error.message));
            if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

            domaindb.add(domain, { zoneName: zoneName, provider: provider, config: result, tlsConfig: tlsConfig }, function (error) {
                if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new DomainsError(DomainsError.ALREADY_EXISTS));
                if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

                reverseProxy.setFallbackCertificate(domain, fallbackCertificate, function (error) {
                    if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

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
        // TODO try to find subdomain entries maybe based on zoneNames or so
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainsError(DomainsError.NOT_FOUND));
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        reverseProxy.getFallbackCertificate(domain, function (error, bundle) {
            if (error && error.reason !== ReverseProxyError.NOT_FOUND) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

            var cert = safe.fs.readFileSync(bundle.certFilePath, 'utf-8');
            var key = safe.fs.readFileSync(bundle.keyFilePath, 'utf-8');

            if (!cert || !key) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, 'unable to read certificates from disk'));

            result.fallbackCertificate = { cert: cert, key: key };

            return callback(null, result);
        });
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    domaindb.getAll(function (error, result) {
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function update(domain, zoneName, provider, config, fallbackCertificate, tlsConfig, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof provider, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof fallbackCertificate, 'object');
    assert.strictEqual(typeof tlsConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    domaindb.get(domain, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainsError(DomainsError.NOT_FOUND));
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        if (zoneName) {
            if (!tld.isValid(zoneName)) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Invalid zoneName'));
        } else {
            zoneName = result.zoneName;
        }

        if (fallbackCertificate) {
            let error = reverseProxy.validateCertificate(`test.${domain}`, fallbackCertificate.cert, fallbackCertificate.key);
            if (error) return callback(new DomainsError(DomainsError.BAD_FIELD, error.message));
        }

        if (tlsConfig.provider !== 'fallback' && tlsConfig.provider !== 'caas' && tlsConfig.provider.indexOf('letsencrypt-') !== 0) {
            return callback(new DomainsError(DomainsError.BAD_FIELD, 'tlsConfig.provider must be caas, fallback or letsencrypt-*'));
        }

        sysinfo.getPublicIp(function (error, ip) {
            if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, 'Error getting IP:' + error.message));

            verifyDnsConfig(config, domain, zoneName, provider, ip, function (error, result) {
                if (error && error.reason === DomainsError.ACCESS_DENIED) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Error adding A record. Access denied'));
                if (error && error.reason === DomainsError.NOT_FOUND) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Zone not found'));
                if (error && error.reason === DomainsError.EXTERNAL_ERROR) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Error adding A record:' + error.message));
                if (error && error.reason === DomainsError.BAD_FIELD) return callback(new DomainsError(DomainsError.BAD_FIELD, error.message));
                if (error && error.reason === DomainsError.INVALID_PROVIDER) return callback(new DomainsError(DomainsError.BAD_FIELD, error.message));
                if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

                domaindb.update(domain, { zoneName: zoneName, provider: provider, config: result, tlsConfig: tlsConfig }, function (error) {
                    if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainsError(DomainsError.NOT_FOUND));
                    if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

                    if (!fallbackCertificate) return callback();

                    reverseProxy.setFallbackCertificate(domain, fallbackCertificate, function (error) {
                        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

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

    domaindb.del(domain, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainsError(DomainsError.NOT_FOUND));
        if (error && error.reason === DatabaseError.IN_USE) return callback(new DomainsError(DomainsError.IN_USE));
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function getName(domain, subdomain) {
    // support special caas domains
    if (domain.provider === 'caas') return subdomain;

    if (domain.domain === domain.zoneName) return subdomain;

    var part = domain.domain.slice(0, -domain.zoneName.length - 1);

    return subdomain === '' ? part : subdomain + '.' + part;
}

function getDnsRecords(subdomain, domain, type, callback) {
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    get(domain, function (error, result) {
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        api(result.provider).get(result.config, result.zoneName, getName(result, subdomain), type, function (error, values) {
            if (error) return callback(error);

            callback(null, values);
        });
    });
}

function upsertDnsRecords(subdomain, domain, type, values, callback) {
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug('upsertDNSRecord: %s on %s type %s values', subdomain, domain, type, values);

    get(domain, function (error, result) {
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        api(result.provider).upsert(result.config, result.zoneName, getName(result, subdomain), type, values, function (error) {
            if (error) return callback(error);

            callback(null);
        });
    });
}

function removeDnsRecords(subdomain, domain, type, values, callback) {
    assert.strictEqual(typeof subdomain, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug('removeDNSRecord: %s on %s type %s values', subdomain, domain, type, values);

    get(domain, function (error, result) {
        if (error) return callback(error);

        api(result.provider).del(result.config, result.zoneName, getName(result, subdomain), type, values, function (error) {
            if (error && error.reason !== DomainsError.NOT_FOUND) return callback(error);

            callback(null);
        });
    });
}

// only wait for A record
function waitForDnsRecord(fqdn, domain, value, options, callback) {
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof value, 'string');
    assert(options && typeof options === 'object'); // { interval: 5000, times: 50000 }
    assert.strictEqual(typeof callback, 'function');

    get(domain, function (error, result) {
        if (error) return callback(error);

        api(result.provider).waitForDns(fqdn, result ? result.zoneName : domain, value, options, callback);
    });
}

function setAdmin(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('setAdmin domain:%s', domain);

    get(domain, function (error, result) {
        if (error) return callback(error);

        var setPtrRecord = config.provider() === 'caas' ? caas.setPtrRecord : function (d, next) { next(); };

        setPtrRecord(domain, function (error) {
            if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, 'Error setting PTR record:' + error.message));

            config.setAdminDomain(result.domain);
            config.setAdminLocation('my');
            config.setAdminFqdn('my' + (result.config.hyphenatedSubdomains ? '-' : '.') + result.domain);

            callback();

            shell.sudo('restart', [ RESTART_CMD ], NOOP_CALLBACK);
        });
    });
}

function fqdn(location, domain, domainObject) {
    return location + (location ? (domainObject.config.hyphenatedSubdomains ? '-' : '.') : '') + domain;
}

// removes all fields that are strictly private and should never be returned by API calls
function removePrivateFields(domain) {
    var result = _.pick(domain, 'domain', 'zoneName', 'provider', 'config', 'tlsConfig', 'fallbackCertificate');
    if (result.fallbackCertificate) delete result.fallbackCertificate.key;  // do not return the 'key'. in caas, this is private
    return result;
}

// removes all fields that are not accessible by a normal user
function removeRestrictedFields(domain) {
    var result = _.pick(domain, 'domain', 'zoneName', 'provider');
    return result;
}