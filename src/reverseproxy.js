'use strict';

exports = module.exports = {
    ReverseProxyError: ReverseProxyError,

    setFallbackCertificate: setFallbackCertificate,
    getFallbackCertificate: getFallbackCertificate,

    generateFallbackCertificateSync: generateFallbackCertificateSync,
    setAppCertificateSync: setAppCertificateSync,

    validateCertificate: validateCertificate,

    getCertificate: getCertificate,

    renewAll: renewAll,
    renewCerts: renewCerts,

    configureDefaultServer: configureDefaultServer,

    configureAdmin: configureAdmin,
    configureApp: configureApp,
    unconfigureApp: unconfigureApp,

    reload: reload,
    removeAppConfigs: removeAppConfigs,

    // exported for testing
    _getCertApi: getCertApi
};

var acme2 = require('./cert/acme2.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    caas = require('./cert/caas.js'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    crypto = require('crypto'),
    debug = require('debug')('box:reverseproxy'),
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
    rimraf = require('rimraf'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    users = require('./users.js'),
    util = require('util');

var NGINX_APPCONFIG_EJS = fs.readFileSync(__dirname + '/../setup/start/nginx/appconfig.ejs', { encoding: 'utf8' }),
    RELOAD_NGINX_CMD = path.join(__dirname, 'scripts/reloadnginx.sh');

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

function getCertApi(domainObject, callback) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (domainObject.tlsConfig.provider === 'fallback') return callback(null, fallback, { fallback: true });

    var api = domainObject.tlsConfig.provider === 'caas' ? caas : acme2;

    var options = { prod: false, performHttpAuthorization: false, wildcard: false, email: '' };
    if (domainObject.tlsConfig.provider !== 'caas') { // matches 'le-prod' or 'letsencrypt-prod'
        options.prod = domainObject.tlsConfig.provider.match(/.*-prod/) !== null;
        options.performHttpAuthorization = domainObject.provider.match(/noop|manual|wildcard/) !== null;
        options.wildcard = !!domainObject.tlsConfig.wildcard;
    }

    // registering user with an email requires A or MX record (https://github.com/letsencrypt/boulder/issues/1197)
    // we cannot use admin@fqdn because the user might not have set it up.
    // we simply update the account with the latest email we have each time when getting letsencrypt certs
    // https://github.com/ietf-wg-acme/acme/issues/30
    users.getOwner(function (error, owner) {
        options.email = error ? 'support@cloudron.io' : (owner.fallbackEmail || owner.email); // can error if not activated yet

        callback(null, api, options);
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

// checks if the certificate matches the options provided by user (like wildcard, le-staging etc)
function providerMatchesSync(domainObject, certFilePath, apiOptions) {
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof certFilePath, 'string');
    assert.strictEqual(typeof apiOptions, 'object');

    if (!fs.existsSync(certFilePath)) return false; // not found

    if (apiOptions.fallback) return certFilePath.includes('.host.cert');

    const subjectAndIssuer = safe.child_process.execSync(`/usr/bin/openssl x509 -noout -subject -issuer -in "${certFilePath}"`, { encoding: 'utf8' });

    const subject = subjectAndIssuer.match(/^subject=(.*)$/m)[1];
    const issuer = subjectAndIssuer.match(/^issuer=(.*)$/m)[1];
    const isWildcardCert = subject.includes('*');
    const isLetsEncryptProd = issuer.includes('Let\'s Encrypt Authority');

    const issuerMismatch = (apiOptions.prod && !isLetsEncryptProd) || (!apiOptions.prod && isLetsEncryptProd);
    // bare domain is not part of wildcard SAN
    const wildcardMismatch = (subject !== domainObject.domain) && (apiOptions.wildcard && !isWildcardCert) || (!apiOptions.wildcard && isWildcardCert);

    const mismatch = issuerMismatch || wildcardMismatch;

    debug(`providerMatchesSync: ${certFilePath} subject=${subject} issuer=${issuer} wildcard=${isWildcardCert}/${apiOptions.wildcard} prod=${isLetsEncryptProd}/${apiOptions.prod} match=${!mismatch}`);

    return !mismatch;
}

// note: https://tools.ietf.org/html/rfc4346#section-7.4.2 (certificate_list) requires that the
// servers certificate appears first (and not the intermediate cert)
function validateCertificate(location, domainObject, certificate) {
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domainObject, 'object');
    assert(certificate && typeof certificate, 'object');

    const cert = certificate.cert, key = certificate.key;

    // check for empty cert and key strings
    if (!cert && key) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, 'missing cert');
    if (cert && !key) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, 'missing key');

    // -checkhost checks for SAN or CN exclusively. SAN takes precedence and if present, ignores the CN.
    const fqdn = domains.fqdn(location, domainObject);

    var result = safe.child_process.execSync(`openssl x509 -noout -checkhost "${fqdn}"`, { encoding: 'utf8', input: cert });
    if (!result) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, 'Unable to get certificate subject.');

    if (result.indexOf('does match certificate') === -1) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, `Certificate is not valid for this domain. Expecting ${fqdn}`);

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

function generateFallbackCertificateSync(domainObject) {
    assert.strictEqual(typeof domainObject, 'object');

    const domain = domainObject.domain;
    const certFilePath = path.join(os.tmpdir(), `${domain}-${crypto.randomBytes(4).readUInt32LE(0)}.cert`);
    const keyFilePath = path.join(os.tmpdir(), `${domain}-${crypto.randomBytes(4).readUInt32LE(0)}.key`);

    let opensslConf = safe.fs.readFileSync('/etc/ssl/openssl.cnf', 'utf8');
    // SAN must contain all the domains since CN check is based on implementation if SAN is found. -checkhost also checks only SAN if present!
    let opensslConfWithSan;
    let cn = domainObject.config.hyphenatedSubdomains ? domains.parentDomain(domain) : domain;

    debug(`generateFallbackCertificateSync: domain=${domainObject.domain} cn=${cn} hyphenated=${domainObject.config.hyphenatedSubdomains}`);

    opensslConfWithSan = `${opensslConf}\n[SAN]\nsubjectAltName=DNS:${domain},DNS:*.${cn}\n`;
    let configFile = path.join(os.tmpdir(), 'openssl-' + crypto.randomBytes(4).readUInt32LE(0) + '.conf');
    safe.fs.writeFileSync(configFile, opensslConfWithSan, 'utf8');
    let certCommand = util.format(`openssl req -x509 -newkey rsa:2048 -keyout ${keyFilePath} -out ${certFilePath} -days 3650 -subj /CN=*.${cn} -extensions SAN -config ${configFile} -nodes`);
    if (!safe.child_process.execSync(certCommand)) return { error: new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, safe.error.message) };
    safe.fs.unlinkSync(configFile);

    const cert = safe.fs.readFileSync(certFilePath, 'utf8');
    if (!cert) return { error: safe.error };
    safe.fs.unlinkSync(certFilePath);

    const key = safe.fs.readFileSync(keyFilePath, 'utf8');
    if (!key) return { error: safe.error };
    safe.fs.unlinkSync(keyFilePath);

    return { cert: cert, key: key, error: null };
}

function setFallbackCertificate(domain, fallback, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert(fallback && typeof fallback === 'object');
    assert.strictEqual(typeof fallback, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (fallback.restricted) { // restricted certs are not backed up
        debug(`setFallbackCertificate: setting restricted certs for domain ${domain}`);
        if (!safe.fs.writeFileSync(path.join(paths.NGINX_CERT_DIR, `${domain}.host.cert`), fallback.cert)) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, safe.error.message));
        if (!safe.fs.writeFileSync(path.join(paths.NGINX_CERT_DIR, `${domain}.host.key`), fallback.key)) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, safe.error.message));
    } else {
        debug(`setFallbackCertificate: setting certs for domain ${domain}`);
        if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, `${domain}.host.cert`), fallback.cert)) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, safe.error.message));
        if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, `${domain}.host.key`), fallback.key)) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, safe.error.message));
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

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, { certFilePath, keyFilePath, type: 'provisioned' });

    // check for auto-generated or user set fallback certs
    certFilePath = path.join(paths.APP_CERTS_DIR, `${domain}.host.cert`);
    keyFilePath = path.join(paths.APP_CERTS_DIR, `${domain}.host.key`);

    callback(null, { certFilePath, keyFilePath, type: 'fallback' });
}

function setAppCertificateSync(location, domainObject, certificate) {
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof certificate, 'object');

    let fqdn = domains.fqdn(location, domainObject);
    if (certificate.cert && certificate.key) {
        if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, `${fqdn}.user.cert`), certificate.cert)) return safe.error;
        if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, `${fqdn}.user.key`), certificate.key)) return safe.error;
    } else { // remove existing cert/key
        if (!safe.fs.unlinkSync(path.join(paths.APP_CERTS_DIR, `${fqdn}.user.cert`))) debug('Error removing cert: ' + safe.error.message);
        if (!safe.fs.unlinkSync(path.join(paths.APP_CERTS_DIR, `${fqdn}.user.key`))) debug('Error removing key: ' + safe.error.message);
    }

    return null;
}

function getCertificateByHostname(hostname, domainObject, callback) {
    assert.strictEqual(typeof hostname, 'string');
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof callback, 'function');

    let certFilePath = path.join(paths.APP_CERTS_DIR, `${hostname}.user.cert`);
    let keyFilePath = path.join(paths.APP_CERTS_DIR, `${hostname}.user.key`);

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, { certFilePath, keyFilePath });

    if (hostname !== domainObject.domain && domainObject.tlsConfig.wildcard) { // bare domain is not part of wildcard SAN
        let certName = domains.makeWildcard(hostname).replace('*.', '_.');
        certFilePath = path.join(paths.APP_CERTS_DIR, `${certName}.cert`);
        keyFilePath = path.join(paths.APP_CERTS_DIR, `${certName}.key`);

        if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, { certFilePath, keyFilePath });
    } else {
        certFilePath = path.join(paths.APP_CERTS_DIR, `${hostname}.cert`);
        keyFilePath = path.join(paths.APP_CERTS_DIR, `${hostname}.key`);

        if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, { certFilePath, keyFilePath });
    }

    callback(null);
}

function getCertificate(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    domains.get(app.domain, function (error, domainObject) {
        if (error) return callback(error);

        getCertificateByHostname(app.fqdn, domainObject, function (error, result) {
            if (error || result) return callback(error, result);

            return getFallbackCertificate(app.domain, callback);
        });
    });
}

function ensureCertificate(vhost, domain, auditSource, callback) {
    assert.strictEqual(typeof vhost, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    domains.get(domain, function (error, domainObject) {
        if (error) return callback(error);

        getCertApi(domainObject, function (error, api, apiOptions) {
            if (error) return callback(error);

            getCertificateByHostname(vhost, domainObject, function (error, currentBundle) {
                if (currentBundle) {
                    debug(`ensureCertificate: ${vhost} certificate already exists at ${currentBundle.keyFilePath}`);

                    if (currentBundle.certFilePath.endsWith('.user.cert')) return callback(null, currentBundle); // user certs cannot be renewed
                    if (!isExpiringSync(currentBundle.certFilePath, 24 * 30) && providerMatchesSync(domainObject, currentBundle.certFilePath, apiOptions)) return callback(null, currentBundle);
                    debug(`ensureCertificate: ${vhost} cert require renewal`);
                } else {
                    debug(`ensureCertificate: ${vhost} cert does not exist`);
                }

                debug('ensureCertificate: getting certificate for %s with options %j', vhost, apiOptions);

                api.getCertificate(vhost, domain, apiOptions, function (error, certFilePath, keyFilePath) {
                    var errorMessage = error ? error.message : '';

                    if (error) {
                        debug('ensureCertificate: could not get certificate. using fallback certs', error);
                        mailer.certificateRenewalError(vhost, errorMessage);
                    }

                    eventlog.add(currentBundle ? eventlog.ACTION_CERTIFICATE_RENEWAL : eventlog.ACTION_CERTIFICATE_NEW, auditSource, { domain: vhost, errorMessage: errorMessage });

                    // if no cert was returned use fallback. the fallback/caas provider will not provide any for example
                    if (!certFilePath || !keyFilePath) return getFallbackCertificate(domain, callback);

                    callback(null, { certFilePath, keyFilePath, type: 'new-le' });
                });
            });
        });
    });
}

function writeAdminConfig(bundle, configFileName, vhost, callback) {
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

    ensureCertificate(config.adminFqdn(), config.adminDomain(), auditSource, function (error, bundle) {
        if (error) return callback(error);

        writeAdminConfig(bundle, constants.NGINX_ADMIN_CONFIG_FILE_NAME, config.adminFqdn(), callback);
    });
}

function writeAppConfig(app, bundle, callback) {
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

function writeAppRedirectConfig(app, fqdn, bundle, callback) {
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

    // if we change the filename, also change it in unconfigureApp()
    var nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, `${app.id}-redirect-${fqdn}.conf`);
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

    ensureCertificate(app.fqdn, app.domain, auditSource, function (error, bundle) {
        if (error) return callback(error);

        writeAppConfig(app, bundle, function (error) {
            if (error) return callback(error);

            async.eachSeries(app.alternateDomains, function (alternateDomain, callback) {
                ensureCertificate(alternateDomain.fqdn, alternateDomain.domain, auditSource, function (error, bundle) {
                    if (error) return callback(error);

                    writeAppRedirectConfig(app, alternateDomain.fqdn, bundle, callback);
                });
            }, callback);
        });
    });
}

function unconfigureApp(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    // we use globbing to find all nginx configs for an app
    rimraf(path.join(paths.NGINX_APPCONFIG_DIR, `${app.id}*.conf`), function (error) {
        if (error) debug('Error removing nginx configurations of "%s":', app.fqdn, error);

        reload(callback);
    });
}

function renewCerts(options, auditSource, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    apps.getAll(function (error, allApps) {
        if (error) return callback(error);

        var appDomains = [];

        // add webadmin domain
        appDomains.push({ domain: config.adminDomain(), fqdn: config.adminFqdn(), type: 'webadmin', nginxConfigFilename: path.join(paths.NGINX_APPCONFIG_DIR, constants.NGINX_ADMIN_CONFIG_FILE_NAME) });

        // add app main
        allApps.forEach(function (app) {
            appDomains.push({ domain: app.domain, fqdn: app.fqdn, type: 'main', app: app, nginxConfigFilename: path.join(paths.NGINX_APPCONFIG_DIR, app.id + '.conf') });

            app.alternateDomains.forEach(function (alternateDomain) {
                let nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, `${app.id}-redirect-${alternateDomain.fqdn}.conf`);
                appDomains.push({ domain: alternateDomain.domain, fqdn: alternateDomain.fqdn, type: 'alternate', app: app, nginxConfigFilename: nginxConfigFilename });
            });
        });

        if (options.domain) appDomains = appDomains.filter(function (appDomain) { return appDomain.domain === options.domain; });

        async.eachSeries(appDomains, function (appDomain, iteratorCallback) {
            ensureCertificate(appDomain.fqdn, appDomain.domain, auditSource, function (error, bundle) {
                if (error) return iteratorCallback(error); // this can happen if cloudron is not setup yet

                // hack to check if the app's cert changed or not. this doesn't handle prod/staging le change since they use same file name
                let currentNginxConfig = safe.fs.readFileSync(appDomain.nginxConfigFilename, 'utf8') || '';
                if (currentNginxConfig.includes(bundle.certFilePath)) return iteratorCallback();

                debug(`renewCerts: creating new nginx config since ${appDomain.nginxConfigFilename} does not have ${bundle.certFilePath}`);

                // reconfigure since the cert changed
                var configureFunc;
                if (appDomain.type === 'webadmin') configureFunc = writeAdminConfig.bind(null, bundle, constants.NGINX_ADMIN_CONFIG_FILE_NAME, config.adminFqdn());
                else if (appDomain.type === 'main') configureFunc = writeAppConfig.bind(null, appDomain.app, bundle);
                else if (appDomain.type === 'alternate') configureFunc = writeAppRedirectConfig.bind(null, appDomain.app, appDomain.fqdn, bundle);
                else return callback(new Error(`Unknown domain type for ${appDomain.fqdn}. This should never happen`));

                configureFunc(function (ignoredError) {
                    if (ignoredError) debug('renewAll: error reconfiguring app', ignoredError);

                    platform.handleCertChanged(appDomain.fqdn);

                    iteratorCallback(); // move to next domain
                });
            });
        });
    });
}

function renewAll(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('renewAll: Checking certificates for renewal');

    renewCerts({}, auditSource, callback);
}

function removeAppConfigs() {
    for (let appConfigFile of fs.readdirSync(paths.NGINX_APPCONFIG_DIR)) {
        if (appConfigFile !== constants.NGINX_DEFAULT_CONFIG_FILE_NAME && appConfigFile !== constants.NGINX_ADMIN_CONFIG_FILE_NAME) {
            fs.unlinkSync(path.join(paths.NGINX_APPCONFIG_DIR, appConfigFile));
        }
    }
}

function configureDefaultServer(callback) {
    assert.strictEqual(typeof callback, 'function');

    var certFilePath = path.join(paths.NGINX_CERT_DIR,  'default.cert');
    var keyFilePath = path.join(paths.NGINX_CERT_DIR, 'default.key');

    if (!fs.existsSync(certFilePath) || !fs.existsSync(keyFilePath)) {
        debug('configureDefaultServer: create new cert');

        var cn = 'cloudron-' + (new Date()).toISOString(); // randomize date a bit to keep firefox happy
        var certCommand = util.format('openssl req -x509 -newkey rsa:2048 -keyout %s -out %s -days 3650 -subj /CN=%s -nodes', keyFilePath, certFilePath, cn);
        safe.child_process.execSync(certCommand);
    }

    writeAdminConfig({ certFilePath, keyFilePath }, constants.NGINX_DEFAULT_CONFIG_FILE_NAME, '', function (error) {
        if (error) return callback(error);

        debug('configureDefaultServer: done');

        callback(null);
    });
}
