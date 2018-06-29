'use strict';

exports = module.exports = {
    ReverseProxyError: ReverseProxyError,

    setFallbackCertificate: setFallbackCertificate,
    getFallbackCertificate: getFallbackCertificate,

    validateCertificate: validateCertificate,

    getCertificate: getCertificate,

    renewAll: renewAll,

    configureDefaultServer: configureDefaultServer,

    configureAdmin: configureAdmin,
    configureApp: configureApp,
    unconfigureApp: unconfigureApp,

    reload: reload,
    removeAppConfigs: removeAppConfigs,

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
    crypto = require('crypto'),
    debug = require('debug')('box:certificates'),
    domains = require('./domains.js'),
    ejs = require('ejs'),
    eventlog = require('./eventlog.js'),
    fallback = require('./cert/fallback.js'),
    fs = require('fs'),
    mailer = require('./mailer.js'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    platform = require('./platform.js'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    users = require('./users.js'),
    util = require('util');

var NGINX_APPCONFIG_EJS = fs.readFileSync(__dirname + '/../setup/start/nginx/appconfig.ejs', { encoding: 'utf8' }),
    RELOAD_NGINX_CMD = path.join(__dirname, 'scripts/reloadnginx.sh'),
    NOOP_CALLBACK = function (error) { if (error) debug(error); };

function ReverseProxyError(reason, errorOrMessage) {
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
util.inherits(ReverseProxyError, Error);
ReverseProxyError.INTERNAL_ERROR = 'Internal Error';
ReverseProxyError.INVALID_CERT = 'Invalid certificate';
ReverseProxyError.NOT_FOUND = 'Not Found';

function getApi(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    domains.get(app.domain, function (error, domain) {
        if (error) return callback(error);

        if (domain.tlsConfig.provider === 'fallback') return callback(null, fallback, {});

        var api = domain.tlsConfig.provider === 'caas' ? caas : acme;

        var options = { };
        if (domain.tlsConfig.provider === 'caas') {
            options.prod = true;
        } else { // acme
            options.prod = domain.tlsConfig.provider.match(/.*-prod/) !== null; // matches 'le-prod' or 'letsencrypt-prod'
        }

        // registering user with an email requires A or MX record (https://github.com/letsencrypt/boulder/issues/1197)
        // we cannot use admin@fqdn because the user might not have set it up.
        // we simply update the account with the latest email we have each time when getting letsencrypt certs
        // https://github.com/ietf-wg-acme/acme/issues/30
        users.getOwner(function (error, owner) {
            options.email = error ? 'support@cloudron.io' : (owner.fallbackEmail || owner.email); // can error if not activated yet

            callback(null, api, options);
        });
    });
}

function isExpiringSync(certFilePath, hours) {
    assert.strictEqual(typeof certFilePath, 'string');
    assert.strictEqual(typeof hours, 'number');

    if (!fs.existsSync(certFilePath)) return 2; // not found

    var result = safe.child_process.spawnSync('/usr/bin/openssl', [ 'x509', '-checkend', String(60 * 60 * hours), '-in', certFilePath ]);

    debug('isExpiringSync: %s %s %s', certFilePath, result.stdout.toString('utf8').trim(), result.status);

    return result.status === 1; // 1 - expired 0 - not expired
}

// note: https://tools.ietf.org/html/rfc4346#section-7.4.2 (certificate_list) requires that the
// servers certificate appears first (and not the intermediate cert)
function validateCertificate(domain, cert, key) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof cert, 'string');
    assert.strictEqual(typeof key, 'string');

    function matchesDomain(candidate) {
        if (typeof candidate !== 'string') return false;
        if (candidate === domain) return true;
        if (candidate.indexOf('*') === 0 && candidate.slice(2) === domain.slice(domain.indexOf('.') + 1)) return true;

        return false;
    }

    // check for empty cert and key strings
    if (!cert && key) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, 'missing cert');
    if (cert && !key) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, 'missing key');

    // -checkhost checks for SAN or CN exclusively. SAN takes precedence and if present, ignores the CN.
    var result = safe.child_process.execSync(`openssl x509 -noout -checkhost "${domain}"`, { encoding: 'utf8', input: cert });
    if (!result) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, 'Unable to get certificate subject.');

    if (result.indexOf('does match certificate') === -1) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, `Certificate is not valid for this domain. Expecting ${domain}`);

    // http://httpd.apache.org/docs/2.0/ssl/ssl_faq.html#verify
    var certModulus = safe.child_process.execSync('openssl x509 -noout -modulus', { encoding: 'utf8', input: cert });
    var keyModulus = safe.child_process.execSync('openssl rsa -noout -modulus', { encoding: 'utf8', input: key });
    if (certModulus !== keyModulus) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, 'Key does not match the certificate.');

    // check expiration
    result = safe.child_process.execSync('openssl x509 -checkend 0', { encoding: 'utf8', input: cert });
    if (!result) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, 'Certificate has expired.');

    return null;
}

function reload(callback) {
    if (process.env.BOX_ENV === 'test') return callback();

    shell.sudo('reload', [ RELOAD_NGINX_CMD ], callback);
}

function setFallbackCertificate(domain, fallback, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof fallback, 'object');
    assert.strictEqual(typeof callback, 'function');

    const certFilePath = path.join(paths.APP_CERTS_DIR, `${domain}.host.cert`);
    const keyFilePath = path.join(paths.APP_CERTS_DIR, `${domain}.host.key`);

    if (fallback) {
        // backup the cert
        if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, `${domain}.host.cert`), fallback.cert)) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, safe.error.message));
        if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, `${domain}.host.key`), fallback.key)) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, safe.error.message));
    } else if (!fs.existsSync(certFilePath) || !fs.existsSync(keyFilePath)) { // generate it
        let opensslConf = safe.fs.readFileSync('/etc/ssl/openssl.cnf', 'utf8');
        // SAN must contain all the domains since CN check is based on implementation if SAN is found. -checkhost also checks only SAN if present!
        let opensslConfWithSan = `${opensslConf}\n[SAN]\nsubjectAltName=DNS:${domain},DNS:*.${domain}\n`;
        let configFile = path.join(os.tmpdir(), 'openssl-' + crypto.randomBytes(4).readUInt32LE(0) + '.conf');
        safe.fs.writeFileSync(configFile, opensslConfWithSan, 'utf8');
        let certCommand = util.format(`openssl req -x509 -newkey rsa:2048 -keyout ${keyFilePath} -out ${certFilePath} -days 3650 -subj /CN=*.${domain} -extensions SAN -config ${configFile} -nodes`);
        if (!safe.child_process.execSync(certCommand)) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, safe.error.message));
        safe.fs.unlinkSync(configFile);
    }

    platform.handleCertChanged('*.' + domain);

    reload(function (error) {
        if (error) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function getFallbackCertificate(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    // check for any pre-provisioned (caas) certs. they get first priority
    var certFilePath = path.join(paths.NGINX_CERT_DIR, `${domain}.host.cert`);
    var keyFilePath = path.join(paths.NGINX_CERT_DIR, `${domain}.host.key`);

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, { certFilePath, keyFilePath });

    // check for auto-generated or user set fallback certs
    certFilePath = path.join(paths.APP_CERTS_DIR, `${domain}.host.cert`);
    keyFilePath = path.join(paths.APP_CERTS_DIR, `${domain}.host.key`);

    callback(null, { certFilePath, keyFilePath });
}

function getCertificate(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    var certFilePath = path.join(paths.APP_CERTS_DIR, `${app.fqdn}.user.cert`);
    var keyFilePath = path.join(paths.APP_CERTS_DIR, `${app.fqdn}.user.key`);

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, { certFilePath, keyFilePath });

    certFilePath = path.join(paths.APP_CERTS_DIR, `${app.fqdn}.cert`);
    keyFilePath = path.join(paths.APP_CERTS_DIR, `${app.fqdn}.key`);

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, { certFilePath, keyFilePath });

    return getFallbackCertificate(app.domain, callback);
}

function ensureCertificate(app, auditSource, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    const vhost = app.fqdn;

    var certFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.user.cert`);
    var keyFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.user.key`);

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) {
        debug('ensureCertificate: %s. user certificate already exists at %s', vhost, keyFilePath);
        return callback(null, { certFilePath, keyFilePath, reason: 'user' });
    }

    certFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.cert`);
    keyFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.key`);

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) {
        debug('ensureCertificate: %s. certificate already exists at %s', vhost, keyFilePath);

        if (!isExpiringSync(certFilePath, 24 * 30)) return callback(null, { certFilePath, keyFilePath, reason: 'existing-le' });
        debug('ensureCertificate: %s cert require renewal', vhost);
    } else {
        debug('ensureCertificate: %s cert does not exist', vhost);
    }

    getApi(app, function (error, api, apiOptions) {
        if (error) return callback(error);

        debug('ensureCertificate: getting certificate for %s with options %j', vhost, apiOptions);

        api.getCertificate(vhost, apiOptions, function (error, certFilePath, keyFilePath) {
            var errorMessage = error ? error.message : '';

            if (error) {
                debug('ensureCertificate: could not get certificate. using fallback certs', error);
                mailer.certificateRenewalError(vhost, errorMessage);
            }

            eventlog.add(eventlog.ACTION_CERTIFICATE_RENEWAL, auditSource, { domain: vhost, errorMessage: errorMessage });

            // if no cert was returned use fallback. the fallback/caas provider will not provide any for example
            if (!certFilePath || !keyFilePath) return getFallbackCertificate(app.domain, callback);

            callback(null, { certFilePath, keyFilePath, reason: 'new-le' });
        });
    });
}

function configureAdminInternal(bundle, configFileName, vhost, callback) {
    assert.strictEqual(typeof bundle, 'object');
    assert.strictEqual(typeof configFileName, 'string');
    assert.strictEqual(typeof vhost, 'string');
    assert.strictEqual(typeof callback, 'function');

    var data = {
        sourceDir: path.resolve(__dirname, '..'),
        adminOrigin: config.adminOrigin(),
        vhost: vhost, // if vhost is empty it will become the default_server
        hasIPv6: config.hasIPv6(),
        endpoint: 'admin',
        certFilePath: bundle.certFilePath,
        keyFilePath: bundle.keyFilePath,
        xFrameOptions: 'SAMEORIGIN',
        robotsTxtQuoted: JSON.stringify('User-agent: *\nDisallow: /\n')
    };
    var nginxConf = ejs.render(NGINX_APPCONFIG_EJS, data);
    var nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, configFileName);

    if (!safe.fs.writeFileSync(nginxConfigFilename, nginxConf)) return callback(safe.error);

    reload(callback);
}

function configureAdmin(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    var adminApp = { domain: config.adminDomain(), fqdn: config.adminFqdn() };
    ensureCertificate(adminApp, auditSource, function (error, bundle) {
        if (error) return callback(error);

        configureAdminInternal(bundle, constants.NGINX_ADMIN_CONFIG_FILE_NAME, config.adminFqdn(), callback);
    });
}

function configureAppInternal(app, bundle, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof bundle, 'object');
    assert.strictEqual(typeof callback, 'function');

    var sourceDir = path.resolve(__dirname, '..');
    var endpoint = 'app';

    var data = {
        sourceDir: sourceDir,
        adminOrigin: config.adminOrigin(),
        vhost: app.fqdn,
        hasIPv6: config.hasIPv6(),
        port: app.httpPort,
        endpoint: endpoint,
        certFilePath: bundle.certFilePath,
        keyFilePath: bundle.keyFilePath,
        robotsTxtQuoted: app.robotsTxt ? JSON.stringify(app.robotsTxt) : null,
        xFrameOptions: app.xFrameOptions || 'SAMEORIGIN'    // once all apps have been updated/
    };
    var nginxConf = ejs.render(NGINX_APPCONFIG_EJS, data);

    var nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, app.id + '.conf');
    debug('writing config for "%s" to %s with options %j', app.fqdn, nginxConfigFilename, data);

    if (!safe.fs.writeFileSync(nginxConfigFilename, nginxConf)) {
        debug('Error creating nginx config for "%s" : %s', app.fqdn, safe.error.message);
        return callback(safe.error);
    }

    reload(callback);
}

function configureAppRedirect(app, fqdn, bundle, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof bundle, 'object');
    assert.strictEqual(typeof callback, 'function');

    var data = {
        sourceDir: path.resolve(__dirname, '..'),
        vhost: fqdn,
        redirectTo: app.fqdn,
        hasIPv6: config.hasIPv6(),
        endpoint: 'redirect',
        certFilePath: bundle.certFilePath,
        keyFilePath: bundle.keyFilePath,
        robotsTxtQuoted: null,
        xFrameOptions: 'SAMEORIGIN'
    };
    var nginxConf = ejs.render(NGINX_APPCONFIG_EJS, data);

    var nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, `${app.id}-${fqdn}.conf`);
    debug('writing config for "%s" redirecting to "%s" to %s with options %j', app.fqdn, fqdn, nginxConfigFilename, data);

    if (!safe.fs.writeFileSync(nginxConfigFilename, nginxConf)) {
        debug('Error creating nginx redirect config for "%s" : %s', app.fqdn, safe.error.message);
        return callback(safe.error);
    }

    reload(callback);
}

function configureApp(app, auditSource, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    ensureCertificate({ fqdn: app.fqdn, domain: app.domain }, auditSource, function (error, bundle) {
        if (error) return callback(error);

        configureAppInternal(app, bundle, function (error) {
            if (error) return callback(error);

            // now setup alternateDomain redirects if any
            async.eachSeries(app.alternateDomains, function (domain, callback) {
                var fqdn = (domain.subdomain ? (domain.subdomain + '.') : '') + domain.domain;

                ensureCertificate({ fqdn: fqdn, domain: domain.domain }, auditSource, function (error, bundle) {
                    if (error) return callback(error);

                    configureAppRedirect(app, fqdn, bundle, callback);
                });
            }, callback);
        });
    });
}

function unconfigureApp(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    var nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, app.id + '.conf');
    if (!safe.fs.unlinkSync(nginxConfigFilename)) {
        if (safe.error.code !== 'ENOENT') debug('Error removing nginx configuration of "%s": %s', app.fqdn, safe.error.message);
        return callback(null);
    }

    reload(callback);
}

function renewAll(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('renewAll: Checking certificates for renewal');

    apps.getAll(function (error, allApps) {
        if (error) return callback(error);

        allApps.push({ domain: config.adminDomain(), fqdn: config.adminFqdn() }); // inject fake webadmin app

        async.eachSeries(allApps, function (app, iteratorCallback) {
            ensureCertificate(app, auditSource, function (error, bundle) {
                if (error) return iteratorCallback(error); // this can happen if cloudron is not setup yet
                if (bundle.reason !== 'new-le' && bundle.reason !== 'fallback') return iteratorCallback();

                // reconfigure for the case where we got a renewed cert after fallback
                var configureFunc = app.fqdn === config.adminFqdn() ?
                    configureAdminInternal.bind(null, bundle, constants.NGINX_ADMIN_CONFIG_FILE_NAME, config.adminFqdn())
                    : configureAppInternal.bind(null, app, bundle);

                configureFunc(function (ignoredError) {
                    if (ignoredError) debug('fallbackExpiredCertificates: error reconfiguring app', ignoredError);

                    platform.handleCertChanged(app.fqdn);

                    iteratorCallback(); // move to next app
                });
            });
        });
    });
}

function removeAppConfigs() {
    for (var appConfigFile of fs.readdirSync(paths.NGINX_APPCONFIG_DIR)) {
        fs.unlinkSync(path.join(paths.NGINX_APPCONFIG_DIR, appConfigFile));
    }
}

function configureDefaultServer(callback) {
    callback = callback || NOOP_CALLBACK;

    var certFilePath = path.join(paths.NGINX_CERT_DIR,  'default.cert');
    var keyFilePath = path.join(paths.NGINX_CERT_DIR, 'default.key');

    if (!fs.existsSync(certFilePath) || !fs.existsSync(keyFilePath)) {
        debug('configureDefaultServer: create new cert');

        var cn = 'cloudron-' + (new Date()).toISOString(); // randomize date a bit to keep firefox happy
        var certCommand = util.format('openssl req -x509 -newkey rsa:2048 -keyout %s -out %s -days 3650 -subj /CN=%s -nodes', keyFilePath, certFilePath, cn);
        safe.child_process.execSync(certCommand);
    }

    configureAdminInternal({ certFilePath, keyFilePath }, 'default.conf', '', function (error) {
        if (error) return callback(error);

        debug('configureDefaultServer: done');

        callback(null);
    });
}
