'use strict';

exports = module.exports = {
    setup: setup,
    restore: restore,
    activate: activate,

    ProvisionError: ProvisionError
};

var assert = require('assert'),
    async = require('async'),
    backups = require('./backups.js'),
    BackupsError = require('./backups.js').BackupsError,
    config = require('./config.js'),
    constants = require('./constants.js'),
    clients = require('./clients.js'),
    cloudron = require('./cloudron.js'),
    debug = require('debug')('box:provision'),
    domains = require('./domains.js'),
    DomainsError = domains.DomainsError,
    eventlog = require('./eventlog.js'),
    mail = require('./mail.js'),
    path = require('path'),
    safe = require('safetydance'),
    semver = require('semver'),
    settingsdb = require('./settingsdb.js'),
    settings = require('./settings.js'),
    shell = require('./shell.js'),
    superagent = require('superagent'),
    users = require('./users.js'),
    UsersError = users.UsersError,
    tld = require('tldjs'),
    util = require('util');

var RESTART_CMD = path.join(__dirname, 'scripts/restart.sh');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

function ProvisionError(reason, errorOrMessage) {
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
util.inherits(ProvisionError, Error);
ProvisionError.BAD_FIELD = 'Field error';
ProvisionError.BAD_STATE = 'Bad State';
ProvisionError.ALREADY_SETUP = 'Already Setup';
ProvisionError.INTERNAL_ERROR = 'Internal Error';
ProvisionError.EXTERNAL_ERROR = 'External Error';
ProvisionError.ALREADY_PROVISIONED = 'Already Provisioned';

function autoprovision(autoconf, callback) {
    assert.strictEqual(typeof autoconf, 'object');
    assert.strictEqual(typeof callback, 'function');

    async.eachSeries(Object.keys(autoconf), function (key, iteratorDone) {
        debug(`autoprovision: ${key}`);

        switch (key) {
        case 'appstoreConfig':
            if (config.provider() === 'caas') { // skip registration
                settingsdb.set(settings.APPSTORE_CONFIG_KEY, JSON.stringify(autoconf[key]), iteratorDone);
            } else { // register cloudron
                settings.setAppstoreConfig(autoconf[key], iteratorDone);
            }
            break;
        case 'caasConfig':
            settingsdb.set(settings.CAAS_CONFIG_KEY, JSON.stringify(autoconf[key]), iteratorDone);
            break;
        case 'backupConfig':
            settings.setBackupConfig(autoconf[key], iteratorDone);
            break;
        default:
            debug(`autoprovision: ${key} ignored`);
            return iteratorDone();
        }
    }, function (error) {
        if (error) return callback(new ProvisionError(ProvisionError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function unprovision(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('unprovision');

    config.setAdminDomain('');
    config.setAdminFqdn('');
    config.setAdminLocation('my');

    // TODO: also cancel any existing configureWebadmin task
    async.series([
        mail.clearDomains,
        domains.clear
    ], callback);
}

function setup(dnsConfig, autoconf, auditSource, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof autoconf, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    users.isActivated(function (error, activated) {
        if (error) return callback(new ProvisionError(ProvisionError.INTERNAL_ERROR, error));
        if (activated) return callback(new ProvisionError(ProvisionError.ALREADY_SETUP));

        unprovision(function (error) {
            if (error) return callback(new ProvisionError(ProvisionError.INTERNAL_ERROR, error));

            let webadminStatus = cloudron.getWebadminStatus();

            if (webadminStatus.configuring || webadminStatus.restore.active) return callback(new ProvisionError(ProvisionError.BAD_STATE, 'Already restoring or configuring'));

            const domain = dnsConfig.domain.toLowerCase();
            const zoneName = dnsConfig.zoneName ? dnsConfig.zoneName : (tld.getDomain(domain) || domain);

            const adminFqdn = 'my' + (dnsConfig.config.hyphenatedSubdomains ? '-' : '.') + domain;

            debug(`provision: Setting up Cloudron with domain ${domain} and zone ${zoneName} using admin fqdn ${adminFqdn}`);

            let data = {
                zoneName: zoneName,
                provider: dnsConfig.provider,
                config: dnsConfig.config,
                fallbackCertificate: dnsConfig.fallbackCertificate || null,
                tlsConfig: dnsConfig.tlsConfig || { provider: 'letsencrypt-prod' }
            };

            domains.add(domain, data, auditSource, function (error) {
                if (error && error.reason === DomainsError.BAD_FIELD) return callback(new ProvisionError(ProvisionError.BAD_FIELD, error.message));
                if (error && error.reason === DomainsError.ALREADY_EXISTS) return callback(new ProvisionError(ProvisionError.BAD_FIELD, error.message));
                if (error) return callback(new ProvisionError(ProvisionError.INTERNAL_ERROR, error));

                async.series([
                    mail.addDomain.bind(null, domain),
                    cloudron.setDashboardDomain.bind(null, domain), // triggers task to setup my. dns/cert/reverseproxy
                    autoprovision.bind(null, autoconf),
                    eventlog.add.bind(null, eventlog.ACTION_PROVISION, auditSource, { })
                ], callback);
            });
        });
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
        if (error && error.reason === UsersError.ALREADY_EXISTS) return callback(new ProvisionError(ProvisionError.ALREADY_PROVISIONED, 'Already activated'));
        if (error && error.reason === UsersError.BAD_FIELD) return callback(new ProvisionError(ProvisionError.BAD_FIELD, error.message));
        if (error) return callback(new ProvisionError(ProvisionError.INTERNAL_ERROR, error));

        clients.addTokenByUserId('cid-webadmin', userObject.id, Date.now() + constants.DEFAULT_TOKEN_EXPIRATION, {}, function (error, result) {
            if (error) return callback(new ProvisionError(ProvisionError.INTERNAL_ERROR, error));

            eventlog.add(eventlog.ACTION_ACTIVATE, auditSource, { });

            callback(null, {
                userId: userObject.id,
                token: result.accessToken,
                expires: result.expires
            });

            setImmediate(cloudron.onActivated.bind(null, NOOP_CALLBACK)); // hack for now to not block the above http response
        });
    });
}

function restore(backupConfig, backupId, version, autoconf, auditSource, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof autoconf, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!semver.valid(version)) return callback(new ProvisionError(ProvisionError.BAD_STATE, 'version is not a valid semver'));
    if (semver.major(config.version()) !== semver.major(version) || semver.minor(config.version()) !== semver.minor(version)) return callback(new ProvisionError(ProvisionError.BAD_STATE, `Run cloudron-setup with --version ${version} to restore from this backup`));

    let webadminStatus = cloudron.getWebadminStatus();

    if (webadminStatus.configuring || webadminStatus.restore.active) return callback(new ProvisionError(ProvisionError.BAD_STATE, 'Already restoring or configuring'));

    users.isActivated(function (error, activated) {
        if (error) return callback(new ProvisionError(ProvisionError.INTERNAL_ERROR, error));
        if (activated) return callback(new ProvisionError(ProvisionError.ALREADY_PROVISIONED, 'Already activated'));

        backups.testConfig(backupConfig, function (error) {
            if (error && error.reason === BackupsError.BAD_FIELD) return callback(new ProvisionError(ProvisionError.BAD_FIELD, error.message));
            if (error && error.reason === BackupsError.EXTERNAL_ERROR) return callback(new ProvisionError(ProvisionError.EXTERNAL_ERROR, error.message));
            if (error) return callback(new ProvisionError(ProvisionError.INTERNAL_ERROR, error));

            debug(`restore: restoring from ${backupId} from provider ${backupConfig.provider} with format ${backupConfig.format}`);

            webadminStatus.restore.active = true;
            webadminStatus.restore.error = null;

            callback(null); // do no block

            async.series([
                backups.restore.bind(null, backupConfig, backupId, (progress) => debug(`restore: ${progress}`)),
                eventlog.add.bind(null, eventlog.ACTION_RESTORE, auditSource, { backupId }),
                autoprovision.bind(null, autoconf),
                // currently, our suggested restore flow is after a dnsSetup. The dnSetup creates DKIM keys and updates the DNS
                // for this reason, we have to re-setup DNS after a restore so it has DKIm from the backup
                // Once we have a 100% IP based restore, we can skip this
                mail.setDnsRecords.bind(null, config.adminDomain()),
                shell.sudo.bind(null, 'restart', [ RESTART_CMD ], {})
            ], function (error) {
                debug('restore:', error);
                if (error) webadminStatus.restore.error = error.message;
                webadminStatus.restore.active = false;
            });
        });
    });
}
