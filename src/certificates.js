'use strict';

exports = module.exports = {
    CertificatesError: CertificatesError,

    ensureFallbackCertificate: ensureFallbackCertificate,
    setFallbackCertificate: setFallbackCertificate,
    getFallbackCertificate: getFallbackCertificate,

    validateCertificate: validateCertificate,
    ensureCertificate: ensureCertificate,

    setAdminCertificate: setAdminCertificate,
    getAdminCertificate: getAdminCertificate,

    renewAll: renewAll,

    initialize: initialize,
    uninitialize: uninitialize,

    events: null,

    EVENT_CERT_CHANGED: 'cert_changed',

    // exported for testing
    _getApi: getApi
};

var acme = require('./cert/acme.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    caas = require('./cert/caas.js'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    debug = require('debug')('box:certificates'),
    eventlog = require('./eventlog.js'),
    fallback = require('./cert/fallback.js'),
    fs = require('fs'),
    mailer = require('./mailer.js'),
    nginx = require('./nginx.js'),
    path = require('path'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    user = require('./user.js'),
    util = require('util');

function CertificatesError(reason, errorOrMessage) {
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
util.inherits(CertificatesError, Error);
CertificatesError.INTERNAL_ERROR = 'Internal Error';
CertificatesError.INVALID_CERT = 'Invalid certificate';
CertificatesError.NOT_FOUND = 'Not Found';

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    exports.events = new (require('events').EventEmitter)();
    callback();
}

function uninitialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    exports.events = null;
    callback();
}

function getApi(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    settings.getTlsConfig(function (error, tlsConfig) {
        if (error) return callback(error);

        if (tlsConfig.provider === 'fallback') return callback(null, fallback, {});

        // use acme if we have altDomain or the tlsConfig is not caas
        var api = (app.altDomain || tlsConfig.provider !== 'caas') ? acme : caas;

        var options = { };
        if (tlsConfig.provider === 'caas') {
            options.prod = true; // with altDomain, we will choose acme setting based on this
        } else { // acme
            options.prod = tlsConfig.provider.match(/.*-prod/) !== null;
        }

        // registering user with an email requires A or MX record (https://github.com/letsencrypt/boulder/issues/1197)
        // we cannot use admin@fqdn because the user might not have set it up.
        // we simply update the account with the latest email we have each time when getting letsencrypt certs
        // https://github.com/ietf-wg-acme/acme/issues/30
        user.getOwner(function (error, owner) {
            options.email = error ? 'support@cloudron.io' : (owner.fallbackEmail || owner.email); // can error if not activated yet

            callback(null, api, options);
        });
    });
}

function ensureFallbackCertificate(callback) {
    // ensure a fallback certificate that much of our code requires
    var certFilePath = path.join(paths.APP_CERTS_DIR, 'host.cert');
    var keyFilePath = path.join(paths.APP_CERTS_DIR, 'host.key');

    var fallbackCertPath = path.join(paths.NGINX_CERT_DIR, 'host.cert');
    var fallbackKeyPath = path.join(paths.NGINX_CERT_DIR, 'host.key');

    if (fs.existsSync(fallbackCertPath) && fs.existsSync(fallbackKeyPath)) {
        debug('ensureFallbackCertificate: pre-existing fallback certs');
        return callback();
    }

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) { // existing custom fallback certs (when restarting, restoring, updating)
        debug('ensureFallbackCertificate: using fallback certs provided by user');
        if (!safe.child_process.execSync('cp ' + certFilePath + ' ' + fallbackCertPath)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));
        if (!safe.child_process.execSync('cp ' + keyFilePath + ' ' + fallbackKeyPath)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));

        return callback();
    }

    // generate a self-signed cert. it's in backup dir so that we don't create a new cert across restarts
    // FIXME: this cert does not cover the naked domain. needs SAN
    if (config.fqdn()) {
        debug('ensureFallbackCertificate: generating self-signed certificate');
        var certCommand = util.format('openssl req -x509 -newkey rsa:2048 -keyout %s -out %s -days 3650 -subj /CN=*.%s -nodes', keyFilePath, certFilePath, config.fqdn());
        safe.child_process.execSync(certCommand);

        if (!safe.child_process.execSync('cp ' + certFilePath + ' ' + fallbackCertPath)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));
        if (!safe.child_process.execSync('cp ' + keyFilePath + ' ' + fallbackKeyPath)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));

        return callback();
    } else {
        debug('ensureFallbackCertificate: cannot generate fallback certificate without domain');
        return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, 'No domain set'));
    }
}

function isExpiringSync(certFilePath, hours) {
    assert.strictEqual(typeof certFilePath, 'string');
    assert.strictEqual(typeof hours, 'number');

    if (!fs.existsSync(certFilePath)) return 2; // not found

    var result = safe.child_process.spawnSync('/usr/bin/openssl', [ 'x509', '-checkend', String(60 * 60 * hours), '-in', certFilePath ]);

    debug('isExpiringSync: %s %s %s', certFilePath, result.stdout.toString('utf8').trim(), result.status);

    return result.status === 1; // 1 - expired 0 - not expired
}

function renewAll(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('renewAll: Checking certificates for renewal');

    apps.getAll(function (error, allApps) {
        if (error) return callback(error);

        allApps.push({ intrinsicFqdn: config.adminFqdn() }); // inject fake webadmin app

        var expiringApps = [ ];
        for (var i = 0; i < allApps.length; i++) {
            var appDomain = allApps[i].altDomain || allApps[i].instrincFqdn;

            var certFilePath = path.join(paths.APP_CERTS_DIR, appDomain + '.user.cert');
            var keyFilePath = path.join(paths.APP_CERTS_DIR, appDomain + '.user.key');

            if (safe.fs.existsSync(certFilePath) && safe.fs.existsSync(keyFilePath)) {
                debug('renewAll: existing user key file for %s. skipping', appDomain);
                continue;
            }

            // check if we have an auto cert to be renewed
            certFilePath = path.join(paths.APP_CERTS_DIR, appDomain + '.cert');
            keyFilePath = path.join(paths.APP_CERTS_DIR, appDomain + '.key');

            if (!safe.fs.existsSync(keyFilePath)) {
                debug('renewAll: no existing key file for %s. skipping', appDomain);
                continue;
            }

            if (isExpiringSync(certFilePath, 24 * 30)) { // expired or not found
                expiringApps.push(allApps[i]);
            }
        }

        debug('renewAll: %j needs to be renewed', expiringApps.map(function (app) { return app.altDomain || app.intrinsicFqdn; }));

        async.eachSeries(expiringApps, function iterator(app, iteratorCallback) {
            var domain = app.altDomain || app.intrinsicFqdn;

            getApi(app, function (error, api, apiOptions) {
                if (error) return callback(error);

                debug('renewAll: renewing cert for %s with options %j', domain, apiOptions);

                api.getCertificate(domain, apiOptions, function (error) {
                    var certFilePath = path.join(paths.APP_CERTS_DIR, domain + '.cert');
                    var keyFilePath = path.join(paths.APP_CERTS_DIR, domain + '.key');

                    var errorMessage = error ? error.message : '';
                    eventlog.add(eventlog.ACTION_CERTIFICATE_RENEWAL, auditSource, { domain: domain, errorMessage: errorMessage });

                    if (error) {
                        debug('renewAll: could not renew cert for %s because %s', domain, error);

                        mailer.certificateRenewalError(domain, errorMessage);

                        // check if we should fallback if we expire in the coming day
                        if (!isExpiringSync(certFilePath, 24 * 1)) return iteratorCallback();

                        debug('renewAll: using fallback certs for %s since it expires soon', domain, error);

                        // if no cert was returned use fallback, the fallback provider will not provide any for example
                        var fallbackCertFilePath = path.join(paths.NGINX_CERT_DIR, domain + '.cert');
                        var fallbackKeyFilePath = path.join(paths.NGINX_CERT_DIR, domain + '.key');

                        certFilePath = fs.existsSync(fallbackCertFilePath) ? fallbackCertFilePath : 'cert/host.cert';
                        keyFilePath = fs.existsSync(fallbackKeyFilePath) ? fallbackKeyFilePath : 'cert/host.key';
                    } else {
                        debug('renewAll: certificate for %s renewed', domain);
                    }

                    // reconfigure and reload nginx. this is required for the case where we got a renewed cert after fallback
                    var configureFunc = app.intrinsicFqdn === config.adminFqdn() ?
                        nginx.configureAdmin.bind(null, certFilePath, keyFilePath, constants.NGINX_ADMIN_CONFIG_FILE_NAME, config.adminFqdn())
                        : nginx.configureApp.bind(null, app, certFilePath, keyFilePath);

                    configureFunc(function (ignoredError) {
                        if (ignoredError) debug('fallbackExpiredCertificates: error reconfiguring app', ignoredError);

                        exports.events.emit(exports.EVENT_CERT_CHANGED, domain);

                        iteratorCallback(); // move to next app
                    });
                });
            });
        });
    });
}

// note: https://tools.ietf.org/html/rfc4346#section-7.4.2 (certificate_list) requires that the
// servers certificate appears first (and not the intermediate cert)
function validateCertificate(cert, key, domain) {
    assert(cert === null || typeof cert === 'string');
    assert(key === null || typeof key === 'string');
    assert.strictEqual(typeof domain, 'string');

    function matchesDomain(candidate) {
        if (typeof candidate !== 'string') return false;
        if (candidate === domain) return true;
        if (candidate.indexOf('*') === 0 && candidate.slice(2) === domain.slice(domain.indexOf('.') + 1)) return true;

        return false;
    }

    if (cert === null && key === null) return null;
    if (!cert && key) return new Error('missing cert');
    if (cert && !key) return new Error('missing key');

    var result = safe.child_process.execSync('openssl x509 -noout -checkhost "' + domain + '"', { encoding: 'utf8', input: cert });
    if (!result) return new Error('Invalid certificate. Unable to get certificate subject.');

    // if no match, check alt names
    if (result.indexOf('does match certificate') === -1) {
        // https://github.com/drwetter/testssl.sh/pull/383
        var cmd = 'openssl x509 -noout -text | grep -A3 "Subject Alternative Name" | \
                   grep "DNS:" | \
                   sed -e "s/DNS://g" -e "s/ //g" -e "s/,/ /g" -e "s/othername:<unsupported>//g"';
        result = safe.child_process.execSync(cmd, { encoding: 'utf8', input: cert });
        var altNames = result ? [ ] : result.trim().split(' '); // might fail if cert has no SAN
        debug('validateCertificate: detected altNames as %j', altNames);

        // check altNames
        if (!altNames.some(matchesDomain)) return new Error(util.format('Certificate is not valid for this domain. Expecting %s in %j', domain, altNames));
    }

    // http://httpd.apache.org/docs/2.0/ssl/ssl_faq.html#verify
    var certModulus = safe.child_process.execSync('openssl x509 -noout -modulus', { encoding: 'utf8', input: cert });
    var keyModulus = safe.child_process.execSync('openssl rsa -noout -modulus', { encoding: 'utf8', input: key });
    if (certModulus !== keyModulus) return new Error('Key does not match the certificate.');

    // check expiration
    result = safe.child_process.execSync('openssl x509 -checkend 0', { encoding: 'utf8', input: cert });
    if (!result) return new Error('Certificate is expired.');

    return null;
}

function setFallbackCertificate(cert, key, domain, callback) {
    assert.strictEqual(typeof cert, 'string');
    assert.strictEqual(typeof key, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    // backup the cert
    if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, domain + '.cert'), cert)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));
    if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, domain + '.key'), key)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));

    // copy over fallback cert
    if (!safe.fs.writeFileSync(path.join(paths.NGINX_CERT_DIR, domain + '.cert'), cert)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));
    if (!safe.fs.writeFileSync(path.join(paths.NGINX_CERT_DIR, domain + '.key'), key)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));

    exports.events.emit(exports.EVENT_CERT_CHANGED, '*.' + domain);

    nginx.reload(function (error) {
        if (error) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function getFallbackCertificate(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    var cert = safe.fs.readFileSync(path.join(paths.NGINX_CERT_DIR, domain + '.cert'), 'utf-8');
    var key = safe.fs.readFileSync(path.join(paths.NGINX_CERT_DIR, domain + '.key'), 'utf-8');

    if (!cert || !key) return callback(new CertificatesError(CertificatesError.NOT_FOUND));

    callback(null, { cert: cert, key: key });
}

function setAdminCertificate(cert, key, callback) {
    assert.strictEqual(typeof cert, 'string');
    assert.strictEqual(typeof key, 'string');
    assert.strictEqual(typeof callback, 'function');

    var vhost = config.adminFqdn();
    var certFilePath = path.join(paths.APP_CERTS_DIR, vhost + '.user.cert');
    var keyFilePath = path.join(paths.APP_CERTS_DIR, vhost + '.user.key');

    var error = validateCertificate(cert, key, vhost);
    if (error) return callback(new CertificatesError(CertificatesError.INVALID_CERT, error.message));

    // backup the cert
    if (!safe.fs.writeFileSync(certFilePath, cert)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));
    if (!safe.fs.writeFileSync(keyFilePath, key)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));

    exports.events.emit(exports.EVENT_CERT_CHANGED, vhost);

    nginx.configureAdmin(certFilePath, keyFilePath, constants.NGINX_ADMIN_CONFIG_FILE_NAME, config.adminFqdn(), callback);
}

function getAdminCertificatePath(callback) {
    assert.strictEqual(typeof callback, 'function');

    var vhost = config.adminFqdn();
    var certFilePath = path.join(paths.APP_CERTS_DIR, vhost + '.user.cert');
    var keyFilePath = path.join(paths.APP_CERTS_DIR, vhost + '.user.key');

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, certFilePath, keyFilePath);

    certFilePath = path.join(paths.APP_CERTS_DIR, vhost + '.cert');
    keyFilePath = path.join(paths.APP_CERTS_DIR, vhost + '.key');

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, certFilePath, keyFilePath);

    // any user fallback cert is always copied over to nginx cert dir
    callback(null, path.join(paths.NGINX_CERT_DIR, 'host.cert'), path.join(paths.NGINX_CERT_DIR, 'host.key'));
}

function getAdminCertificate(callback) {
    assert.strictEqual(typeof callback, 'function');

    getAdminCertificatePath(function (error, certFilePath, keyFilePath) {
        if (error) return callback(error);

        var cert = safe.fs.readFileSync(certFilePath);
        if (!cert) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error));

        var key = safe.fs.readFileSync(keyFilePath);
        if (!cert) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error));

        return callback(null, cert, key);
    });
}

function ensureCertificate(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    var domain = app.altDomain || app.intrinsicFqdn;

    var certFilePath = path.join(paths.APP_CERTS_DIR, domain + '.user.cert');
    var keyFilePath = path.join(paths.APP_CERTS_DIR, domain + '.user.key');

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) {
        debug('ensureCertificate: %s. user certificate already exists at %s', domain, keyFilePath);
        return callback(null, certFilePath, keyFilePath);
    }

    certFilePath = path.join(paths.APP_CERTS_DIR, domain + '.cert');
    keyFilePath = path.join(paths.APP_CERTS_DIR, domain + '.key');

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) {
        debug('ensureCertificate: %s. certificate already exists at %s', domain, keyFilePath);

        if (!isExpiringSync(certFilePath, 24 * 1)) return callback(null, certFilePath, keyFilePath);
        debug('ensureCertificate: %s cert require renewal', domain);
    } else {
        debug('ensureCertificate: %s cert does not exist', domain);
    }

    getApi(app, function (error, api, apiOptions) {
        if (error) return callback(error);

        debug('ensureCertificate: getting certificate for %s with options %j', domain, apiOptions);

        api.getCertificate(domain, apiOptions, function (error, certFilePath, keyFilePath) {
            if (error) debug('ensureCertificate: could not get certificate. using fallback certs', error);

            // if no cert was returned use fallback, the fallback provider will not provide any for example
            if (!certFilePath || !keyFilePath) {
                var fallbackCertFilePath = path.join(paths.NGINX_CERT_DIR, app.domain + '.cert');
                var fallbackKeyFilePath = path.join(paths.NGINX_CERT_DIR, app.domain + '.key');

                certFilePath = fs.existsSync(fallbackCertFilePath) ? fallbackCertFilePath : 'cert/host.cert';
                keyFilePath = fs.existsSync(fallbackKeyFilePath) ? fallbackKeyFilePath : 'cert/host.key';
            }

            callback(null, certFilePath, keyFilePath);
        });
    });
}
