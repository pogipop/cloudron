'use strict';

module.exports = exports = {
    add: add,
    get: get,
    getAll: getAll,
    update: update,
    del: del,
    clear: clear,

    fqdn: fqdn,
    getName: getName,

    getDnsRecords: getDnsRecords,
    upsertDnsRecords: upsertDnsRecords,
    removeDnsRecords: removeDnsRecords,

    waitForDnsRecord: waitForDnsRecord,

    removePrivateFields: removePrivateFields,
    removeRestrictedFields: removeRestrictedFields,

    validateHostname: validateHostname,

    makeWildcard: makeWildcard,

    parentDomain: parentDomain,

    prepareDashboardDomain: prepareDashboardDomain,

    DomainsError: DomainsError
};

var assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:domains'),
    domaindb = require('./domaindb.js'),
    eventlog = require('./eventlog.js'),
    reverseProxy = require('./reverseproxy.js'),
    ReverseProxyError = reverseProxy.ReverseProxyError,
    safe = require('safetydance'),
    sysinfo = require('./sysinfo.js'),
    tld = require('tldjs'),
    util = require('util'),
    _ = require('underscore');

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
DomainsError.INVALID_PROVIDER = 'provider must be route53, gcdns, digitalocean, gandi, cloudflare, namecom, noop, wildcard, manual or caas';

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
    case 'namecheap': return require('./dns/namecheap.js');
    case 'noop': return require('./dns/noop.js');
    case 'manual': return require('./dns/manual.js');
    case 'wildcard': return require('./dns/wildcard.js');
    default: return null;
    }
}

function parentDomain(domain) {
    assert.strictEqual(typeof domain, 'string');
    return domain.replace(/^\S+?\./, ''); // +? means non-greedy
}

function verifyDnsConfig(dnsConfig, domain, zoneName, provider, callback) {
    assert(dnsConfig && typeof dnsConfig === 'object'); // the dns config to test with
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof provider, 'string');
    assert.strictEqual(typeof callback, 'function');

    var backend = api(provider);
    if (!backend) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Invalid provider'));

    const domainObject = { config: dnsConfig, domain: domain, zoneName: zoneName };
    api(provider).verifyDnsConfig(domainObject, function (error, result) {
        if (error && error.reason === DomainsError.ACCESS_DENIED) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Incorrect configuration. Access denied'));
        if (error && error.reason === DomainsError.NOT_FOUND) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Zone not found'));
        if (error && error.reason === DomainsError.EXTERNAL_ERROR) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Configuration error: ' + error.message));
        if (error && error.reason === DomainsError.BAD_FIELD) return callback(new DomainsError(DomainsError.BAD_FIELD, error.message));
        if (error && error.reason === DomainsError.INVALID_PROVIDER) return callback(new DomainsError(DomainsError.BAD_FIELD, error.message));
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        result.hyphenatedSubdomains = !!dnsConfig.hyphenatedSubdomains;

        callback(null, result);
    });
}

function fqdn(location, domainObject) {
    return location + (location ? (domainObject.config.hyphenatedSubdomains ? '-' : '.') : '') + domainObject.domain;
}

// Hostname validation comes from RFC 1123 (section 2.1)
// Domain name validation comes from RFC 2181 (Name syntax)
// https://en.wikipedia.org/wiki/Hostname#Restrictions_on_valid_host_names
// We are validating the validity of the location-fqdn as host name (and not dns name)
function validateHostname(location, domainObject) {
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domainObject, 'object');

    const hostname = fqdn(location, domainObject);

    const RESERVED_LOCATIONS = [
        constants.API_LOCATION,
        constants.SMTP_LOCATION,
        constants.IMAP_LOCATION
    ];
    if (RESERVED_LOCATIONS.indexOf(location) !== -1) return new DomainsError(DomainsError.BAD_FIELD, location + ' is reserved');

    if (hostname === config.adminFqdn()) return new DomainsError(DomainsError.BAD_FIELD, location + ' is reserved');

    // workaround https://github.com/oncletom/tld.js/issues/73
    var tmp = hostname.replace('_', '-');
    if (!tld.isValid(tmp)) return new DomainsError(DomainsError.BAD_FIELD, 'Hostname is not a valid domain name');

    if (hostname.length > 253) return new DomainsError(DomainsError.BAD_FIELD, 'Hostname length exceeds 253 characters');

    if (location) {
        // label validation
        if (location.split('.').some(function (p) { return p.length > 63 || p.length < 1; })) return new DomainsError(DomainsError.BAD_FIELD, 'Invalid subdomain length');
        if (location.match(/^[A-Za-z0-9-.]+$/) === null) return new DomainsError(DomainsError.BAD_FIELD, 'Subdomain can only contain alphanumeric, hyphen and dot');
        if (/^[-.]/.test(location)) return new DomainsError(DomainsError.BAD_FIELD, 'Subdomain cannot start or end with hyphen or dot');
    }

    if (domainObject.config.hyphenatedSubdomains) {
        if (location.indexOf('.') !== -1) return new DomainsError(DomainsError.BAD_FIELD, 'Subdomain cannot contain a dot');
    }

    return null;
}

function validateTlsConfig(tlsConfig, dnsProvider) {
    assert.strictEqual(typeof tlsConfig, 'object');
    assert.strictEqual(typeof dnsProvider, 'string');

    switch (tlsConfig.provider) {
    case 'letsencrypt-prod':
    case 'letsencrypt-staging':
    case 'fallback':
    case 'caas':
        break;
    default:
        return new DomainsError(DomainsError.BAD_FIELD, 'tlsConfig.provider must be caas, fallback, letsencrypt-prod/staging');
    }

    if (tlsConfig.wildcard) {
        if (!tlsConfig.provider.startsWith('letsencrypt')) return new DomainsError(DomainsError.BAD_FIELD, 'wildcard can only be set with letsencrypt');
        if (dnsProvider === 'manual' || dnsProvider === 'noop' || dnsProvider === 'wildcard') return new DomainsError(DomainsError.BAD_FIELD, 'wildcard cert requires a programmable DNS backend');
    }

    return null;
}

function add(domain, data, auditSource, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof data.zoneName, 'string');
    assert.strictEqual(typeof data.provider, 'string');
    assert.strictEqual(typeof data.config, 'object');
    assert.strictEqual(typeof data.fallbackCertificate, 'object');
    assert.strictEqual(typeof data.tlsConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    let { zoneName, provider, config, fallbackCertificate, tlsConfig } = data;

    if (!tld.isValid(domain)) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Invalid domain'));
    if (domain.endsWith('.')) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Invalid domain'));

    if (zoneName) {
        if (!tld.isValid(zoneName)) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Invalid zoneName'));
        if (zoneName.endsWith('.')) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Invalid zoneName'));
    } else {
        zoneName = tld.getDomain(domain) || domain;
    }

    if (fallbackCertificate) {
        let error = reverseProxy.validateCertificate('test', { domain, config }, fallbackCertificate);
        if (error) return callback(new DomainsError(DomainsError.BAD_FIELD, error.message));
    } else {
        fallbackCertificate = reverseProxy.generateFallbackCertificateSync({ domain, config });
        if (fallbackCertificate.error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, fallbackCertificate.error));
    }

    let error = validateTlsConfig(tlsConfig, provider);
    if (error) return callback(error);

    verifyDnsConfig(config, domain, zoneName, provider, function (error, sanitizedConfig) {
        if (error) return callback(error);

        domaindb.add(domain, { zoneName: zoneName, provider: provider, config: sanitizedConfig, tlsConfig: tlsConfig }, function (error) {
            if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new DomainsError(DomainsError.ALREADY_EXISTS));
            if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

            reverseProxy.setFallbackCertificate(domain, fallbackCertificate, function (error) {
                if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

                eventlog.add(eventlog.ACTION_DOMAIN_ADD, auditSource, { domain, zoneName, provider });

                callback();
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

function update(domain, data, auditSource, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof data.zoneName, 'string');
    assert.strictEqual(typeof data.provider, 'string');
    assert.strictEqual(typeof data.config, 'object');
    assert.strictEqual(typeof data.fallbackCertificate, 'object');
    assert.strictEqual(typeof data.tlsConfig, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    let { zoneName, provider, config, fallbackCertificate, tlsConfig } = data;

    domaindb.get(domain, function (error, domainObject) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainsError(DomainsError.NOT_FOUND));
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        if (zoneName) {
            if (!tld.isValid(zoneName)) return callback(new DomainsError(DomainsError.BAD_FIELD, 'Invalid zoneName'));
        } else {
            zoneName = domainObject.zoneName;
        }

        if (fallbackCertificate) {
            let error = reverseProxy.validateCertificate('test', domainObject, fallbackCertificate);
            if (error) return callback(new DomainsError(DomainsError.BAD_FIELD, error.message));
        }

        error = validateTlsConfig(tlsConfig, provider);
        if (error) return callback(error);

        verifyDnsConfig(config, domain, zoneName, provider, function (error, sanitizedConfig) {
            if (error) return callback(error);

            domaindb.update(domain, { zoneName: zoneName, provider: provider, config: sanitizedConfig, tlsConfig: tlsConfig }, function (error) {
                if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainsError(DomainsError.NOT_FOUND));
                if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

                if (!fallbackCertificate) return callback();

                reverseProxy.setFallbackCertificate(domain, fallbackCertificate, function (error) {
                    if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

                    eventlog.add(eventlog.ACTION_DOMAIN_UPDATE, auditSource, { domain, zoneName, provider });

                    callback();
                });
            });
        });
    });
}

function del(domain, auditSource, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (domain === config.adminDomain()) return callback(new DomainsError(DomainsError.IN_USE));

    domaindb.del(domain, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DomainsError(DomainsError.NOT_FOUND));
        if (error && error.reason === DatabaseError.IN_USE) return callback(new DomainsError(DomainsError.IN_USE));
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        eventlog.add(eventlog.ACTION_DOMAIN_REMOVE, auditSource, { domain });

        return callback(null);
    });
}

function clear(callback) {
    assert.strictEqual(typeof callback, 'function');

    domaindb.clear(function (error) {
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

// returns the 'name' that needs to be inserted into zone
function getName(domain, location, type) {
    const part = domain.domain.slice(0, -domain.zoneName.length - 1);

    if (location === '') return part;

    if (!domain.config.hyphenatedSubdomains) return part ? `${location}.${part}` : location;

    // hyphenatedSubdomains
    if (type !== 'TXT') return `${location}-${part}`;

    if (location.startsWith('_acme-challenge.')) {
        return `${location}-${part}`;
    } else if (location === '_acme-challenge') {
        const up = part.replace(/^[^.]*\.?/, ''); // this gets the domain one level up
        return up ? `${location}.${up}` : location;
    } else {
        return `${location}.${part}`;
    }
}

function getDnsRecords(location, domain, type, callback) {
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    get(domain, function (error, domainObject) {
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        api(domainObject.provider).get(domainObject, location, type, function (error, values) {
            if (error) return callback(error);

            callback(null, values);
        });
    });
}

// note: for TXT records the values must be quoted
function upsertDnsRecords(location, domain, type, values, callback) {
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug('upsertDNSRecord: %s on %s type %s values', location, domain, type, values);

    get(domain, function (error, domainObject) {
        if (error) return callback(new DomainsError(DomainsError.INTERNAL_ERROR, error));

        api(domainObject.provider).upsert(domainObject, location, type, values, function (error) {
            if (error) return callback(error);

            callback(null);
        });
    });
}

function removeDnsRecords(location, domain, type, values, callback) {
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert(util.isArray(values));
    assert.strictEqual(typeof callback, 'function');

    debug('removeDNSRecord: %s on %s type %s values', location, domain, type, values);

    get(domain, function (error, domainObject) {
        if (error) return callback(error);

        api(domainObject.provider).del(domainObject, location, type, values, function (error) {
            if (error && error.reason !== DomainsError.NOT_FOUND) return callback(error);

            callback(null);
        });
    });
}

function waitForDnsRecord(location, domain, type, value, options, callback) {
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert(type === 'A' || type === 'TXT');
    assert.strictEqual(typeof value, 'string');
    assert(options && typeof options === 'object'); // { interval: 5000, times: 50000 }
    assert.strictEqual(typeof callback, 'function');

    get(domain, function (error, domainObject) {
        if (error) return callback(error);

        api(domainObject.provider).wait(domainObject, location, type, value, options, callback);
    });
}

// removes all fields that are strictly private and should never be returned by API calls
function removePrivateFields(domain) {
    var result = _.pick(domain, 'domain', 'zoneName', 'provider', 'config', 'tlsConfig', 'fallbackCertificate', 'locked');
    if (result.fallbackCertificate) delete result.fallbackCertificate.key;  // do not return the 'key'. in caas, this is private
    return result;
}

// removes all fields that are not accessible by a normal user
function removeRestrictedFields(domain) {
    var result = _.pick(domain, 'domain', 'zoneName', 'provider', 'locked');

    // always ensure config object
    result.config = { hyphenatedSubdomains: !!domain.config.hyphenatedSubdomains };

    return result;
}

function makeWildcard(hostname) {
    assert.strictEqual(typeof hostname, 'string');

    let parts = hostname.split('.');
    parts[0] = '*';
    return parts.join('.');
}

function prepareDashboardDomain(domain, auditSource, progressCallback, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    get(domain, function (error, domainObject) {
        if (error) return callback(error);

        sysinfo.getPublicIp(function (error, ip) {
            if (error) return callback(new DomainsError(DomainsError.EXTERNAL_ERROR, error.message));

            async.series([
                (done) => { progressCallback({ percent: 10, message: 'Updating DNS' }); done(); },
                upsertDnsRecords.bind(null, constants.ADMIN_LOCATION, domain, 'A', [ ip ]),
                (done) => { progressCallback({ percent: 40, message: 'Waiting for DNS' }); done(); },
                waitForDnsRecord.bind(null, constants.ADMIN_LOCATION, domain, 'A', ip, { interval: 30000, times: 50000 }),
                (done) => { progressCallback({ percent: 70, message: 'Getting certificate' }); done(); },
                reverseProxy.ensureCertificate.bind(null, fqdn(constants.ADMIN_LOCATION, domainObject), domain, auditSource)
            ], function (error) {
                if (error) return callback(error);

                callback(null);
            });
        });
    });
}