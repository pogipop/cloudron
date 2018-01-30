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
    debug = require('debug')('box:certificates'),
    ejs = require('ejs'),
    eventlog = require('./eventlog.js'),
    fallback = require('./cert/fallback.js'),
    fs = require('fs'),
    mailer = require('./mailer.js'),
    path = require('path'),
    paths = require('./paths.js'),
    platform = require('./platform.js'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    shell = require('./shell.js'),
    user = require('./user.js'),
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
            var appDomain = allApps[i].altDomain || allApps[i].intrinsicFqdn;

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
                        certFilePath = path.join(paths.NGINX_CERT_DIR, domain + '.host.cert');
                        keyFilePath = path.join(paths.NGINX_CERT_DIR, domain + '.host.key');
                    } else {
                        debug('renewAll: certificate for %s renewed', domain);
                    }

                    // reconfigure and reload nginx. this is required for the case where we got a renewed cert after fallback
                    var configureFunc = app.intrinsicFqdn === config.adminFqdn() ?
                        configureAdminInternal.bind(null, certFilePath, keyFilePath, constants.NGINX_ADMIN_CONFIG_FILE_NAME, config.adminFqdn())
                        : configureApp.bind(null, app, certFilePath, keyFilePath);

                    configureFunc(function (ignoredError) {
                        if (ignoredError) debug('fallbackExpiredCertificates: error reconfiguring app', ignoredError);

                        platform.handleCertChanged(domain);

                        iteratorCallback(); // move to next app
                    });
                });
            });
        });
    });
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

    var result = safe.child_process.execSync('openssl x509 -noout -checkhost "' + domain + '"', { encoding: 'utf8', input: cert });
    if (!result) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, 'Unable to get certificate subject.');

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
        if (!altNames.some(matchesDomain)) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, util.format('Certificate is not valid for this domain. Expecting %s in %j', domain, altNames));
    }

    // http://httpd.apache.org/docs/2.0/ssl/ssl_faq.html#verify
    var certModulus = safe.child_process.execSync('openssl x509 -noout -modulus', { encoding: 'utf8', input: cert });
    var keyModulus = safe.child_process.execSync('openssl rsa -noout -modulus', { encoding: 'utf8', input: key });
    if (certModulus !== keyModulus) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, 'Key does not match the certificate.');

    // check expiration
    result = safe.child_process.execSync('openssl x509 -checkend 0', { encoding: 'utf8', input: cert });
    if (!result) return new ReverseProxyError(ReverseProxyError.INVALID_CERT, 'Certificate has expired.');

    return null;
}

// We configure nginx to always use the fallback cert from the runtime directory (NGINX_CERT_DIR)
// This is done because Caas wildcard certs should not be part of the backup
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
        var certCommand = util.format('openssl req -x509 -newkey rsa:2048 -keyout %s -out %s -days 3650 -subj /CN=*.%s -nodes', keyFilePath, certFilePath, domain);
        if (!safe.child_process.execSync(certCommand)) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, safe.error.message));
    }

    // copy over fallback cert
    var fallbackCertFilePath = path.join(paths.NGINX_CERT_DIR, `${domain}.host.cert`);
    var fallbackKeyFilePath = path.join(paths.NGINX_CERT_DIR, `${domain}.host.key`);

    if (!safe.child_process.execSync(`cp ${certFilePath} ${fallbackCertFilePath}`)) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, safe.error.message));
    if (!safe.child_process.execSync(`cp ${keyFilePath} ${fallbackKeyFilePath}`)) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, safe.error.message));

    platform.handleCertChanged('*.' + domain);

    reload(function (error) {
        if (error) return callback(new ReverseProxyError(ReverseProxyError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function getFallbackCertificate(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback(null, path.join(paths.NGINX_CERT_DIR, `${domain}.host.cert`), path.join(paths.NGINX_CERT_DIR, `${domain}.host.key`));
}

function getCertificate(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    var vhost = app.altDomain || app.intrinsicFqdn;

    var certFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.user.cert`);
    var keyFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.user.key`);

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, certFilePath, keyFilePath);

    certFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.cert`);
    keyFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.key`);

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, certFilePath, keyFilePath);

    // any user fallback cert is always copied over to nginx cert dir
    callback(null, path.join(paths.NGINX_CERT_DIR, `${app.domain}.host.cert`), path.join(paths.NGINX_CERT_DIR, `${app.domain}.host.key`));
}

function ensureCertificate(app, auditSource, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    var vhost = app.altDomain || app.intrinsicFqdn;

    var certFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.user.cert`);
    var keyFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.user.key`);

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) {
        debug('ensureCertificate: %s. user certificate already exists at %s', vhost, keyFilePath);
        return callback(null, certFilePath, keyFilePath);
    }

    certFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.cert`);
    keyFilePath = path.join(paths.APP_CERTS_DIR, `${vhost}.key`);

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) {
        debug('ensureCertificate: %s. certificate already exists at %s', vhost, keyFilePath);

        if (!isExpiringSync(certFilePath, 24 * 1)) return callback(null, certFilePath, keyFilePath);
        debug('ensureCertificate: %s cert require renewal', vhost);
    } else {
        debug('ensureCertificate: %s cert does not exist', vhost);
    }

    getApi(app, function (error, api, apiOptions) {
        if (error) return callback(error);

        debug('ensureCertificate: getting certificate for %s with options %j', vhost, apiOptions);

        api.getCertificate(vhost, apiOptions, function (error, certFilePath, keyFilePath) {
            if (error) {
                debug('ensureCertificate: could not get certificate. using fallback certs', error);
                mailer.certificateRenewalError(vhost, errorMessage);
            }

            var errorMessage = error ? error.message : '';
            eventlog.add(eventlog.ACTION_CERTIFICATE_RENEWAL, auditSource, { domain: vhost, errorMessage: errorMessage });

            // if no cert was returned use fallback. the fallback/caas provider will not provide any for example
            if (!certFilePath || !keyFilePath) {
                certFilePath = path.join(paths.NGINX_CERT_DIR, `${app.domain}.host.cert`);
                keyFilePath = path.join(paths.NGINX_CERT_DIR, `${app.domain}.host.key`);
            }

            callback(null, certFilePath, keyFilePath);
        });
    });
}

function configureAdminInternal(certFilePath, keyFilePath, configFileName, vhost, callback) {
    assert.strictEqual(typeof certFilePath, 'string');
    assert.strictEqual(typeof keyFilePath, 'string');
    assert.strictEqual(typeof configFileName, 'string');
    assert.strictEqual(typeof vhost, 'string');
    assert.strictEqual(typeof callback, 'function');

    var data = {
        sourceDir: path.resolve(__dirname, '..'),
        adminOrigin: config.adminOrigin(),
        vhost: vhost, // if vhost is empty it will become the default_server
        hasIPv6: config.hasIPv6(),
        endpoint: 'admin',
        certFilePath: certFilePath,
        keyFilePath: keyFilePath,
        xFrameOptions: 'SAMEORIGIN',
        robotsTxtQuoted: JSON.stringify('User-agent: *\nDisallow: /\n')
    };
    var nginxConf = ejs.render(NGINX_APPCONFIG_EJS, data);
    var nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, configFileName);

    if (!safe.fs.writeFileSync(nginxConfigFilename, nginxConf)) return callback(safe.error);

    reload(callback);
}

function configureAdmin(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'function');
    assert.strictEqual(typeof callback, 'function');

    var adminApp = { domain: config.adminDomain(), intrinsicFqdn: config.adminFqdn() };
    ensureCertificate(auditSource, adminApp, function (error, certFilePath, keyFilePath) {
        if (error) return callback(error);

        configureAdminInternal(certFilePath, keyFilePath, constants.NGINX_ADMIN_CONFIG_FILE_NAME, config.adminFqdn(), callback);
    });
}

function configureApp(app, auditSource, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    ensureCertificate(app, auditSource, function (error, certFilePath, keyFilePath) {
        if (error) return callback(error);

        var sourceDir = path.resolve(__dirname, '..');
        var endpoint = 'app';
        var vhost = app.altDomain || app.intrinsicFqdn;

        var data = {
            sourceDir: sourceDir,
            adminOrigin: config.adminOrigin(),
            vhost: vhost,
            hasIPv6: config.hasIPv6(),
            port: app.httpPort,
            endpoint: endpoint,
            certFilePath: certFilePath,
            keyFilePath: keyFilePath,
            robotsTxtQuoted: app.robotsTxt ? JSON.stringify(app.robotsTxt) : null,
            xFrameOptions: app.xFrameOptions || 'SAMEORIGIN'    // once all apps have been updated/
        };
        var nginxConf = ejs.render(NGINX_APPCONFIG_EJS, data);

        var nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, app.id + '.conf');
        debug('writing config for "%s" to %s with options %j', vhost, nginxConfigFilename, data);

        if (!safe.fs.writeFileSync(nginxConfigFilename, nginxConf)) {
            debug('Error creating nginx config for "%s" : %s', vhost, safe.error.message);
            return callback(safe.error);
        }

        reload(callback);
    });
}

function unconfigureApp(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    var vhost = app.altDomain || app.intrinsicFqdn;

    var nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, app.id + '.conf');
    if (!safe.fs.unlinkSync(nginxConfigFilename)) {
        if (safe.error.code !== 'ENOENT') debug('Error removing nginx configuration of "%s": %s', vhost, safe.error.message);
        return callback(null);
    }

    reload(callback);
}

function reload(callback) {
    shell.sudo('reload', [ RELOAD_NGINX_CMD ], callback);
}

function removeAppConfigs() {
    for (var appConfigFile of fs.readdirSync(paths.NGINX_APPCONFIG_DIR)) {
        fs.unlinkSync(path.join(paths.NGINX_APPCONFIG_DIR, appConfigFile));
    }
}

function configureDefaultServer(callback) {
    callback = callback || NOOP_CALLBACK;

    if (process.env.BOX_ENV === 'test') return callback();

    var certFilePath = path.join(paths.NGINX_CERT_DIR,  'default.cert');
    var keyFilePath = path.join(paths.NGINX_CERT_DIR, 'default.key');

    if (!fs.existsSync(certFilePath) || !fs.existsSync(keyFilePath)) {
        debug('configureDefaultServer: create new cert');

        var cn = 'cloudron-' + (new Date()).toISOString(); // randomize date a bit to keep firefox happy
        var certCommand = util.format('openssl req -x509 -newkey rsa:2048 -keyout %s -out %s -days 3650 -subj /CN=%s -nodes', keyFilePath, certFilePath, cn);
        safe.child_process.execSync(certCommand);
    }

    configureAdminInternal(certFilePath, keyFilePath, 'default.conf', '', function (error) {
        if (error) return callback(error);

        debug('configureDefaultServer: done');

        callback(null);
    });
}
