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
    config = require('./config.js'),
    constants = require('./constants.js'),
    clients = require('./clients.js'),
    cloudron = require('./cloudron.js'),
    debug = require('debug')('box:setup'),
    domains = require('./domains.js'),
    DomainsError = domains.DomainsError,
    eventlog = require('./eventlog.js'),
    fs = require('fs'),
    mail = require('./mail.js'),
    path = require('path'),
    paths = require('./paths.js'),
    reverseProxy = require('./reverseproxy.js'),
    safe = require('safetydance'),
    semver = require('semver'),
    settingsdb = require('./settingsdb.js'),
    settings = require('./settings.js'),
    shell = require('./shell.js'),
    superagent = require('superagent'),
    sysinfo = require('./sysinfo.js'),
    users = require('./users.js'),
    UsersError = users.UsersError,
    tld = require('tldjs'),
    util = require('util');

var RESTART_CMD = path.join(__dirname, 'scripts/restart.sh');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

var gWebadminStatus = {
    dns: false,
    tls: false,
    configuring: false,
    restore: {
        active: false,
        error: null
    }
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
SetupError.BAD_STATE = 'Bad State';
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
        case 'backupConfig': name = settings.BACKUP_CONFIG_KEY; break;
        case 'tlsCert':
            debug(`autoprovision: ${key}`);
            return fs.writeFile(path.join(paths.NGINX_CERT_DIR, config.adminDomain() + '.host.cert'), conf[key], iteratorDone);
        case 'tlsKey':
            debug(`autoprovision: ${key}`);
            return fs.writeFile(path.join(paths.NGINX_CERT_DIR, config.adminDomain() + '.host.key'), conf[key], iteratorDone);
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

    function configureReverseProxy(error) {
        debug('configureReverseProxy: error %j', error || null);

        reverseProxy.configureAdmin({ userId: null, username: 'setup' }, function (error) {
            debug('configureWebadmin: done error: %j', error || {});
            gWebadminStatus.configuring = false;

            if (error) return callback(error);

            gWebadminStatus.tls = true;

            callback();
        });
    }

    // update the DNS. configure nginx regardless of whether it succeeded so that
    // box is accessible even if dns creds are invalid
    sysinfo.getPublicIp(function (error, ip) {
        if (error) return configureReverseProxy(error);

        domains.upsertDnsRecords(config.adminLocation(), config.adminDomain(), 'A', [ ip ], function (error) {
            debug('addWebadminDnsRecord: updated records with error:', error);
            if (error) return configureReverseProxy(error);

            domains.waitForDnsRecord(config.adminLocation(), config.adminDomain(), 'A', ip, { interval: 30000, times: 50000 }, function (error) {
                if (error) return configureReverseProxy(error);

                gWebadminStatus.dns = true;

                configureReverseProxy();
            });
        });
    });
}

function dnsSetup(adminFqdn, domain, zoneName, provider, dnsConfig, tlsConfig, callback) {
    assert.strictEqual(typeof adminFqdn, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof provider, 'string');
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof tlsConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (config.adminDomain()) return callback(new SetupError(SetupError.ALREADY_SETUP));

    if (gWebadminStatus.configuring || gWebadminStatus.restore.active) return callback(new SetupError(SetupError.BAD_STATE, 'Already restoring or configuring'));

    if (!tld.isValid(adminFqdn) || !adminFqdn.endsWith(domain)) return callback(new SetupError(SetupError.BAD_FIELD, 'adminFqdn must be a subdomain of domain'));

    if (!zoneName) zoneName = tld.getDomain(domain) || domain;

    debug(`dnsSetup: Setting up Cloudron with domain ${domain} and zone ${zoneName} using admin fqdn ${adminFqdn}`);

    function done(error) {
        if (error && error.reason === DomainsError.BAD_FIELD) return callback(new SetupError(SetupError.BAD_FIELD, error.message));
        if (error && error.reason === DomainsError.ALREADY_EXISTS) return callback(new SetupError(SetupError.BAD_FIELD, error.message));
        if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

        config.setAdminDomain(domain); // set fqdn only after dns config is valid, otherwise cannot re-setup if we failed
        config.setAdminFqdn(adminFqdn);
        config.setAdminLocation('my');

        autoprovision(function (error) {
            if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

            clients.addDefaultClients(config.adminOrigin(), callback);

            configureWebadmin(NOOP_CALLBACK);
        });
    }

    domains.get(domain, function (error, result) {
        if (error && error.reason !== DomainsError.NOT_FOUND) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

        if (result) return callback(new SetupError(SetupError.BAD_STATE, 'Domain already exists'));

        async.series([
            domains.add.bind(null, domain, zoneName, provider, dnsConfig, null /* cert */, tlsConfig),
            mail.addDomain.bind(null, domain)
        ], done);
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

    users.createOwner(username, password, email, displayName, auditSource, function (error, userObject) {
        if (error && error.reason === UsersError.ALREADY_EXISTS) return callback(new SetupError(SetupError.ALREADY_PROVISIONED));
        if (error && error.reason === UsersError.BAD_FIELD) return callback(new SetupError(SetupError.BAD_FIELD, error.message));
        if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

        clients.addTokenByUserId('cid-webadmin', userObject.id, Date.now() + constants.DEFAULT_TOKEN_EXPIRATION, {}, function (error, result) {
            if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

            eventlog.add(eventlog.ACTION_ACTIVATE, auditSource, { });

            callback(null, {
                userId: userObject.id,
                token: result.accessToken,
                expires: result.expires
            });

            setTimeout(cloudron.onActivated, 3000); // hack for now to not block the above http response
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

    if (gWebadminStatus.configuring || gWebadminStatus.restore.active) return callback(new SetupError(SetupError.BAD_STATE, 'Already restoring or configuring'));

    users.count(function (error, count) {
        if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));
        if (count) return callback(new SetupError(SetupError.ALREADY_PROVISIONED, 'Already activated'));

        backups.testConfig(backupConfig, function (error) {
            if (error && error.reason === BackupsError.BAD_FIELD) return callback(new SetupError(SetupError.BAD_FIELD, error.message));
            if (error && error.reason === BackupsError.EXTERNAL_ERROR) return callback(new SetupError(SetupError.EXTERNAL_ERROR, error.message));
            if (error) return callback(new SetupError(SetupError.INTERNAL_ERROR, error));

            debug(`restore: restoring from ${backupId} from provider ${backupConfig.provider} with format ${backupConfig.format}`);

            gWebadminStatus.restore.active = true;
            gWebadminStatus.restore.error = null;

            callback(null); // do no block

            async.series([
                backups.restore.bind(null, backupConfig, backupId),
                autoprovision,
                // currently, our suggested restore flow is after a dnsSetup. The dnSetup creates DKIM keys and updates the DNS
                // for this reason, we have to re-setup DNS after a restore so it has DKIm from the backup
                // Once we have a 100% IP based restore, we can skip this
                mail.setDnsRecords.bind(null, config.adminDomain()),
                shell.sudo.bind(null, 'restart', [ RESTART_CMD ])
            ], function (error) {
                debug('restore:', error);
                if (error) gWebadminStatus.restore.error = error.message;
                gWebadminStatus.restore.active = false;
            });
        });
    });
}

function getStatus(callback) {
    assert.strictEqual(typeof callback, 'function');

    users.count(function (error, count) {
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
                edition: config.edition(),
                webadminStatus: gWebadminStatus // only valid when !activated
            });
        });
    });
}
