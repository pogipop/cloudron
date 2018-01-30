'use strict';

exports = module.exports = {
    dnsSetup: dnsSetup,
    restore: restore,
    getStatus: getStatus,
    activate: activate,

    configureWebadmin: configureWebadmin,

    SetupError: SetupError
};

var assert = require('assert'),
    async = require('async'),
    backups = require('./backups.js'),
    BackupsError = require('./backups.js').BackupsError,
    certificates = require('./certificates.js'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    clients = require('./clients.js'),
    cloudron = require('./cloudron.js'),
    debug = require('debug')('box:setup'),
    domains = require('./domains.js'),
    DomainError = domains.DomainError,
    eventlog = require('./eventlog.js'),
    fs = require('fs'),
    mail = require('./mail.js'),
    nginx = require('./nginx.js'),
    path = require('path'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    semver = require('semver'),
    settingsdb = require('./settingsdb.js'),
    settings = require('./settings.js'),
    SettingsError = settings.SettingsError,
    shell = require('./shell.js'),
    superagent = require('superagent'),
    sysinfo = require('./sysinfo.js'),
    tokendb = require('./tokendb.js'),
    user = require('./user.js'),
    UserError = user.UserError,
    tld = require('tldjs'),
    util = require('util');

var RESTART_CMD = path.join(__dirname, 'scripts/restart.sh');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

var gWebadminStatus = {
    dns: false,
    tls: false,
    configuring: false,
    restoring: false
};

function SetupError(reason, errorOrMessage) {
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
util.inherits(SetupError, Error);
SetupError.BAD_FIELD = 'Field error';
SetupError.BAD_STATE = 'Field error';
SetupError.ALREADY_SETUP = 'Already Setup';
SetupError.INTERNAL_ERROR = 'Internal Error';
SetupError.EXTERNAL_ERROR = 'External Error';
SetupError.ALREADY_PROVISIONED = 'Already Provisioned';

function autoprovision(callback) {
    assert.strictEqual(typeof callback, 'function');

    const confJson = safe.fs.readFileSync(paths.AUTO_PROVISION_FILE, 'utf8');
    if (!confJson) return callback();

    const conf = safe.JSON.parse(confJson);
    if (!conf) return callback();

    async.eachSeries(Object.keys(conf), function (key, iteratorDone) {
        var name;
        switch (key) {
        case 'appstoreConfig': name = settings.APPSTORE_CONFIG_KEY; break;
        case 'caasConfig': name = settings.CAAS_CONFIG_KEY; break;
        case 'tlsConfig': name = settings.TLS_CONFIG_KEY; break;
        case 'backupConfig': name = settings.BACKUP_CONFIG_KEY; break;
        case 'tlsCert':
            debug(`autoprovision: ${key}`);
            return fs.writeFile(path.join(paths.NGINX_CERT_DIR, 'host.cert'), conf[key], iteratorDone);
        case 'tlsKey':
            debug(`autoprovision: ${key}`);
            return fs.writeFile(path.join(paths.NGINX_CERT_DIR, 'host.key'), conf[key], iteratorDone);
        default:
            debug(`autoprovision: ${key} ignored`);
            return iteratorDone();
        }

        debug(`autoprovision: ${name}`);
        settingsdb.set(name, JSON.stringify(conf[key]), iteratorDone);
    }, callback);
}

function configureWebadmin(callback) {
    callback = callback || NOOP_CALLBACK;

    debug('configureWebadmin: adminDomain:%s status:%j', config.adminDomain(), gWebadminStatus);

    if (process.env.BOX_ENV === 'test' || !config.adminDomain() || gWebadminStatus.configuring) return callback();

    gWebadminStatus.configuring = true; // re-entracy guard

    function done(error) {
        gWebadminStatus.configuring = false;
        debug('configureWebadmin: done error: %j', error || {});
        callback(error);
    }

    function configureNginx(error) {
        debug('configureNginx: dns update: %j', error || {});

        certificates.ensureCertificate({ domain: config.adminDomain(), location: config.adminLocation(), intrinsicFqdn: config.adminFqdn() }, function (error, certFilePath, keyFilePath) {
            if (error) return done(error);

            gWebadminStatus.tls = true;

            nginx.configureAdmin(certFilePath, keyFilePath, constants.NGINX_ADMIN_CONFIG_FILE_NAME, config.adminFqdn(), done);
        });
    }

    function addWebadminDnsRecord(ip, domain, callback) {
        assert.strictEqual(typeof ip, 'string');
        assert.strictEqual(typeof domain, 'string');
        assert.strictEqual(typeof callback, 'function');

        if (process.env.BOX_ENV === 'test') return callback();

        async.retry({ times: 10, interval: 20000 }, function (retryCallback) {
            domains.upsertDNSRecords(config.adminLocation(), domain, 'A', [ ip ], retryCallback);
        }, function (error) {
            if (error) debug('addWebadminDnsRecord: done updating records with error:', error);
            else debug('addWebadminDnsRecord: done');

            callback(error);
        });
    }

    // update the DNS. configure nginx regardless of whether it succeeded so that
    // box is accessible even if dns creds are invalid
    sysinfo.getPublicIp(function (error, ip) {
        if (error) return configureNginx(error);

        addWebadminDnsRecord(ip, config.adminDomain(), function (error) {
            if (error) return configureNginx(error);

            domains.waitForDNSRecord(config.adminFqdn(), config.adminDomain(), ip, 'A', { interval: 30000, times: 50000 }, function (error) {
                if (error) return configureNginx(error);

                gWebadminStatus.dns = true;

                configureNginx();
            });
        });
    });
}

function dnsSetup(adminFqdn, domain, zoneName, provider, dnsConfig, callback) {
    assert.strictEqual(typeof adminFqdn, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof provider, 'string');
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (config.adminDomain()) return callback(new SetupError(SetupError.ALREADY_SETUP));

    if (!zoneName) zoneName = tld.getDomain(domain) || domain;

    debug('dnsSetup: Setting up Cloudron with domain %s and zone %s', domain, zoneName);

    function done(error) {
        if (error && error.reason === DomainError.BAD_FIELD) return callback(new SetupError(SetupError.BAD_FIELD, error.message));
        if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

        autoprovision(function (error) {
            if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

            config.setAdminDomain(domain); // set fqdn only after dns config is valid, otherwise cannot re-setup if we failed
            config.setAdminFqdn(adminFqdn);
            config.setAdminLocation('my');

            clients.addDefaultClients(config.adminOrigin(), callback);

            async.series([ // do not block
                configureWebadmin
            ], NOOP_CALLBACK);
        });
    }

    domains.get(domain, function (error, result) {
        if (error && error.reason !== DomainError.NOT_FOUND) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        if (!result) {
            async.series([
                domains.add.bind(null, domain, zoneName, provider, dnsConfig, null /* cert */),
                mail.add.bind(null, domain)
            ], done);
        } else {
            domains.update(domain, provider, dnsConfig, null /* cert */, done);
        }
    });
}

function setTimeZone(ip, callback) {
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('setTimeZone ip:%s', ip);

    superagent.get('https://geolocation.cloudron.io/json').query({ ip: ip }).timeout(10 * 1000).end(function (error, result) {
        if ((error && !error.response) || result.statusCode !== 200) {
            debug('Failed to get geo location: %s', error.message);
            return callback(null);
        }

        var timezone = safe.query(result.body, 'location.time_zone');

        if (!timezone || typeof timezone !== 'string') {
            debug('No timezone in geoip response : %j', result.body);
            return callback(null);
        }

        debug('Setting timezone to ', timezone);

        settings.setTimeZone(timezone, callback);
    });
}

function activate(username, password, email, displayName, ip, auditSource, callback) {
    assert.strictEqual(typeof username, 'string');
    assert.strictEqual(typeof password, 'string');
    assert.strictEqual(typeof email, 'string');
    assert.strictEqual(typeof displayName, 'string');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('activating user:%s email:%s', username, email);

    setTimeZone(ip, function () { }); // TODO: get this from user. note that timezone is detected based on the browser location and not the cloudron region

    user.createOwner(username, password, email, displayName, auditSource, function (error, userObject) {
        if (error && error.reason === UserError.ALREADY_EXISTS) return callback(new SetupError(SetupError.ALREADY_PROVISIONED));
        if (error && error.reason === UserError.BAD_FIELD) return callback(new SetupError(SetupError.BAD_FIELD, error.message));
        if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

        clients.get('cid-webadmin', function (error, result) {
            if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

            // Also generate a token so the admin creation can also act as a login
            var token = tokendb.generateToken();
            var expires = Date.now() + constants.DEFAULT_TOKEN_EXPIRATION;

            tokendb.add(token, userObject.id, result.id, expires, '*', function (error) {
                if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

                eventlog.add(eventlog.ACTION_ACTIVATE, auditSource, { });

                cloudron.onActivated();

                callback(null, { token: token, expires: expires });
            });
        });
    });
}

function restore(backupConfig, backupId, version, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!semver.valid(version)) return callback(new SetupError(SetupError.BAD_STATE, 'version is not a valid semver'));
    if (semver.major(config.version()) !== semver.major(version) || semver.minor(config.version()) !== semver.minor(version)) return callback(new SetupError(SetupError.BAD_STATE, `Run cloudron-setup with --version ${version} to restore from this backup`));

    user.count(function (error, count) {
        if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));
        if (count) return callback(new SetupError(SetupError.ALREADY_PROVISIONED, 'Already activated'));

        backups.testConfig(backupConfig, function (error) {
            if (error && error.reason === BackupsError.BAD_FIELD) return callback(new SetupError(SetupError.BAD_FIELD, error.message));
            if (error && error.reason === BackupsError.EXTERNAL_ERROR) return callback(new SetupError(SetupError.EXTERNAL_ERROR, error.message));
            if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

            debug(`restore: restoring from ${backupId} from provider ${backupConfig.provider}`);

            gWebadminStatus.restoring = true;

            callback(null); // do no block

            async.series([
                backups.restore.bind(null, backupConfig, backupId),
                autoprovision,
                shell.sudo.bind(null, 'restart', [ RESTART_CMD ])
            ], function (error) {
                debug('restore:', error);
                gWebadminStatus.restoring = false;
            });
        });
    });
}

function getStatus(callback) {
    assert.strictEqual(typeof callback, 'function');

    user.count(function (error, count) {
        if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

        settings.getCloudronName(function (error, cloudronName) {
            if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

            callback(null, {
                version: config.version(),
                apiServerOrigin: config.apiServerOrigin(), // used by CaaS tool
                provider: config.provider(),
                cloudronName: cloudronName,
                adminFqdn: config.adminDomain() ? config.adminFqdn() : null,
                activated: count !== 0,
                webadminStatus: gWebadminStatus // only valid when !activated
            });
        });
    });
}
