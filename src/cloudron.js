'use strict';

exports = module.exports = {
    CloudronError: CloudronError,

    initialize: initialize,
    uninitialize: uninitialize,
    activate: activate,
    getConfig: getConfig,
    getStatus: getStatus,
    getDisks: getDisks,
    dnsSetup: dnsSetup,
    getLogs: getLogs,

    sendCaasHeartbeat: sendCaasHeartbeat,

    updateToLatest: updateToLatest,
    restore: restore,
    reboot: reboot,
    retire: retire,
    migrate: migrate,

    checkDiskSpace: checkDiskSpace,

    readDkimPublicKeySync: readDkimPublicKeySync,
    refreshDNS: refreshDNS,
    configureWebadmin: configureWebadmin
};

var appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    backups = require('./backups.js'),
    BackupsError = require('./backups.js').BackupsError,
    certificates = require('./certificates.js'),
    child_process = require('child_process'),
    clients = require('./clients.js'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    cron = require('./cron.js'),
    debug = require('debug')('box:cloudron'),
    df = require('@sindresorhus/df'),
    domains = require('./domains.js'),
    DomainError = domains.DomainError,
    eventlog = require('./eventlog.js'),
    fs = require('fs'),
    locker = require('./locker.js'),
    mailer = require('./mailer.js'),
    nginx = require('./nginx.js'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    platform = require('./platform.js'),
    progress = require('./progress.js'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    SettingsError = settings.SettingsError,
    shell = require('./shell.js'),
    spawn = require('child_process').spawn,
    split = require('split'),
    superagent = require('superagent'),
    sysinfo = require('./sysinfo.js'),
    tld = require('tldjs'),
    tokendb = require('./tokendb.js'),
    updateChecker = require('./updatechecker.js'),
    user = require('./user.js'),
    UserError = user.UserError,
    util = require('util'),
    _ = require('underscore');

var REBOOT_CMD = path.join(__dirname, 'scripts/reboot.sh'),
    UPDATE_CMD = path.join(__dirname, 'scripts/update.sh'),
    RETIRE_CMD = path.join(__dirname, 'scripts/retire.sh'),
    RESTART_CMD = path.join(__dirname, 'scripts/restart.sh');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

// result to not depend on the appstore
const BOX_AND_USER_TEMPLATE = {
    box: {
        region: null,
        size: null,
        plan: 'Custom Plan'
    },
    user: {
        billing: false,
        currency: ''
    }
};

var gBoxAndUserDetails = null,         // cached cloudron details like region,size...
    gWebadminStatus = { dns: false, tls: false, configuring: false, restoring: false };

function CloudronError(reason, errorOrMessage) {
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
util.inherits(CloudronError, Error);
CloudronError.BAD_FIELD = 'Field error';
CloudronError.INTERNAL_ERROR = 'Internal Error';
CloudronError.EXTERNAL_ERROR = 'External Error';
CloudronError.ALREADY_PROVISIONED = 'Already Provisioned';
CloudronError.ALREADY_SETUP = 'Already Setup';
CloudronError.BAD_STATE = 'Bad state';
CloudronError.ALREADY_UPTODATE = 'No Update Available';
CloudronError.NOT_FOUND = 'Not found';
CloudronError.SELF_UPGRADE_NOT_SUPPORTED = 'Self upgrade not supported';

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    gWebadminStatus = { dns: false, tls: false, configuring: false, restoring: false };
    gBoxAndUserDetails = null;

    async.series([
        certificates.initialize,
        settings.initialize,
        configureDefaultServer,
        onDomainConfigured,
        onActivated
    ], function (error) {
        if (error) return callback(error);

        configureWebadmin(NOOP_CALLBACK); // for restore() and caas initial setup. do not block

        callback();
    });
}

function uninitialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    async.series([
        cron.uninitialize,
        mailer.stop,
        platform.stop,
        certificates.uninitialize,
        settings.uninitialize
    ], callback);
}

function onDomainConfigured(callback) {
    callback = callback || NOOP_CALLBACK;

    if (!config.fqdn()) return callback();

    async.series([
        clients.addDefaultClients,
        certificates.ensureFallbackCertificate,
        ensureDkimKey
    ], callback);
}

function onActivated(callback) {
    callback = callback || NOOP_CALLBACK;

    // Starting the platform after a user is available means:
    // 1. mail bounces can now be sent to the cloudron owner
    // 2. the restore code path can run without sudo (since mail/ is non-root)
    // 3. timezone is now set for cronjobs
    user.count(function (error, count) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));
        if (!count) return callback(); // not activated

        async.series([
            platform.start, // requires fallback certs for mail container
            mailer.start, // this requires the "mail" container to be running
            cron.initialize
        ], callback);
    });
}

function dnsSetup(dnsConfig, domain, zoneName, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (config.fqdn()) return callback(new CloudronError(CloudronError.ALREADY_SETUP));

    if (!zoneName) zoneName = tld.getDomain(domain) || '';

    debug('dnsSetup: Setting up Cloudron with domain %s and zone %s', domain, zoneName);

    function done(error) {
        if (error && error.reason === DomainError.BAD_FIELD) return callback(new CloudronError(CloudronError.BAD_FIELD, error.message));
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        config.setFqdn(domain); // set fqdn only after dns config is valid, otherwise cannot re-setup if we failed
        config.setZoneName(zoneName);

        async.series([ // do not block
            onDomainConfigured,
            configureWebadmin
        ], NOOP_CALLBACK);

        callback();
    }

    domains.get(domain, function (error, result) {
        if (error && error.reason !== DomainError.NOT_FOUND) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        if (!result) domains.add(domain, zoneName, dnsConfig, null, done);
        else domains.update(domain, dnsConfig, null, done);
    });
}

function configureDefaultServer(callback) {
    callback = callback || NOOP_CALLBACK;

    debug('configureDefaultServer: domain %s', config.fqdn());

    if (process.env.BOX_ENV === 'test') return callback();

    var certFilePath = path.join(paths.NGINX_CERT_DIR,  'default.cert');
    var keyFilePath = path.join(paths.NGINX_CERT_DIR, 'default.key');

    if (!fs.existsSync(certFilePath) || !fs.existsSync(keyFilePath)) {
        debug('configureDefaultServer: create new cert');

        var cn = 'cloudron-' + (new Date()).toISOString(); // randomize date a bit to keep firefox happy
        var certCommand = util.format('openssl req -x509 -newkey rsa:2048 -keyout %s -out %s -days 3650 -subj /CN=%s -nodes', keyFilePath, certFilePath, cn);
        safe.child_process.execSync(certCommand);
    }

    nginx.configureAdmin(certFilePath, keyFilePath, 'default.conf', '', function (error) {
        if (error) return callback(error);

        debug('configureDefaultServer: done');

        callback(null);
    });
}

function configureWebadmin(callback) {
    callback = callback || NOOP_CALLBACK;

    debug('configureWebadmin: fqdn:%s status:%j', config.fqdn(), gWebadminStatus);

    if (process.env.BOX_ENV === 'test' || !config.fqdn() || gWebadminStatus.configuring) return callback();

    gWebadminStatus.configuring = true; // re-entracy guard

    function done(error) {
        gWebadminStatus.configuring = false;
        debug('configureWebadmin: done error: %j', error || {});
        callback(error);
    }

    function configureNginx(error) {
        debug('configureNginx: dns update: %j', error || {});

        certificates.ensureCertificate({ domain: config.fqdn(), location: config.adminLocation() }, function (error, certFilePath, keyFilePath) {
            if (error) return done(error);

            gWebadminStatus.tls = true;

            nginx.configureAdmin(certFilePath, keyFilePath, constants.NGINX_ADMIN_CONFIG_FILE_NAME, config.adminFqdn(), done);
        });
    }

    // update the DNS. configure nginx regardless of whether it succeeded so that
    // box is accessible even if dns creds are invalid
    sysinfo.getPublicIp(function (error, ip) {
        if (error) return configureNginx(error);

        addDnsRecords(ip, function (error) {
            if (error) return configureNginx(error);

            domains.waitForDNSRecord(config.adminFqdn(), ip, 'A', { interval: 30000, times: 50000 }, function (error) {
                if (error) return configureNginx(error);

                gWebadminStatus.dns = true;

                configureNginx();
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

    user.createOwner(username, password, email, displayName, auditSource, function (error, userObject) {
        if (error && error.reason === UserError.ALREADY_EXISTS) return callback(new CloudronError(CloudronError.ALREADY_PROVISIONED));
        if (error && error.reason === UserError.BAD_FIELD) return callback(new CloudronError(CloudronError.BAD_FIELD, error.message));
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        clients.get('cid-webadmin', function (error, result) {
            if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

            // Also generate a token so the admin creation can also act as a login
            var token = tokendb.generateToken();
            var expires = Date.now() + constants.DEFAULT_TOKEN_EXPIRATION;

            tokendb.add(token, userObject.id, result.id, expires, '*', function (error) {
                if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

                eventlog.add(eventlog.ACTION_ACTIVATE, auditSource, { });

                onActivated();

                callback(null, { token: token, expires: expires });
            });
        });
    });
}

function getStatus(callback) {
    assert.strictEqual(typeof callback, 'function');

    user.count(function (error, count) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        settings.getCloudronName(function (error, cloudronName) {
            if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

            callback(null, {
                activated: count !== 0,
                version: config.version(),
                apiServerOrigin: config.apiServerOrigin(), // used by CaaS tool
                provider: config.provider(),
                cloudronName: cloudronName,
                adminFqdn: config.fqdn() ? config.adminFqdn() : null,
                webadminStatus: gWebadminStatus
            });
        });
    });
}

function getDisks(callback) {
    assert.strictEqual(typeof callback, 'function');

    var disks = {
        boxDataDisk: null,
        platformDataDisk: null,
        appsDataDisk: null
    };

    df.file(paths.BOX_DATA_DIR).then(function (result) {
        disks.boxDataDisk = result.filesystem;

        return df.file(paths.PLATFORM_DATA_DIR);
    }).then(function (result) {
        disks.platformDataDisk = result.filesystem;

        return df.file(paths.APPS_DATA_DIR);
    }).then(function (result) {
        disks.appsDataDisk = result.filesystem;

        callback(null, disks);
    }).catch(function (error) {
        callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));
    });
}

function getBoxAndUserDetails(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (gBoxAndUserDetails) return callback(null, gBoxAndUserDetails);

    // only supported for caas
    if (config.provider() !== 'caas') return callback(null, {});

    superagent
        .get(config.apiServerOrigin() + '/api/v1/boxes/' + config.fqdn())
        .query({ token: config.token() })
        .timeout(30 * 1000)
        .end(function (error, result) {
            if (error && !error.response) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, 'Cannot reach appstore'));
            if (result.statusCode !== 200) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

            gBoxAndUserDetails = result.body;

            return callback(null, gBoxAndUserDetails);
        });
}

function getConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    getBoxAndUserDetails(function (error, result) {
        if (error) debug('Failed to fetch cloudron details.', error.reason, error.message);

        result = _.extend(BOX_AND_USER_TEMPLATE, result || {});

        settings.getCloudronName(function (error, cloudronName) {
            if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

            settings.getDeveloperMode(function (error, developerMode) {
                if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

                callback(null, {
                    apiServerOrigin: config.apiServerOrigin(),
                    webServerOrigin: config.webServerOrigin(),
                    fqdn: config.fqdn(),
                    adminLocation: config.adminLocation(),
                    adminFqdn: config.adminFqdn(),
                    mailFqdn: config.mailFqdn(),
                    version: config.version(),
                    update: updateChecker.getUpdateInfo(),
                    progress: progress.getAll(),
                    isCustomDomain: config.isCustomDomain(),
                    isDemo: config.isDemo(),
                    developerMode: developerMode,
                    region: result.box.region,
                    size: result.box.size,
                    billing: !!result.user.billing,
                    plan: result.box.plan,
                    currency: result.user.currency,
                    memory: os.totalmem(),
                    provider: config.provider(),
                    cloudronName: cloudronName
                });
            });
        });
    });
}

function sendCaasHeartbeat() {
    assert(config.provider() === 'caas', 'Heartbeat is only sent for managed cloudrons');

    var url = config.apiServerOrigin() + '/api/v1/boxes/' + config.fqdn() + '/heartbeat';
    superagent.post(url).query({ token: config.token(), version: config.version() }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) debug('Network error sending heartbeat.', error);
        else if (result.statusCode !== 200) debug('Server responded to heartbeat with %s %s', result.statusCode, result.text);
        else debug('Heartbeat sent to %s', url);
    });
}

function ensureDkimKey(callback) {
    assert(config.fqdn(), 'fqdn is not set');

    var dkimPath = path.join(paths.MAIL_DATA_DIR, 'dkim/' + config.fqdn());
    var dkimPrivateKeyFile = path.join(dkimPath, 'private');
    var dkimPublicKeyFile = path.join(dkimPath, 'public');

    if (!fs.existsSync(dkimPrivateKeyFile) || !fs.existsSync(dkimPublicKeyFile)) {
        debug('Generating new DKIM keys');

        if (!safe.fs.mkdirSync(dkimPath) && safe.error.code !== 'EEXIST') {
            debug('Error creating dkim.', safe.error);
            return null;
        }

        child_process.execSync('openssl genrsa -out ' + dkimPrivateKeyFile + ' 1024');
        child_process.execSync('openssl rsa -in ' + dkimPrivateKeyFile + ' -out ' + dkimPublicKeyFile + ' -pubout -outform PEM');
    } else {
        debug('DKIM keys already present');
    }

    callback();
}

function readDkimPublicKeySync() {
    if (!config.fqdn()) {
        debug('Cannot read dkim public key without a domain.', safe.error);
        return null;
    }

    var dkimPath = path.join(paths.MAIL_DATA_DIR, 'dkim/' + config.fqdn());
    var dkimPublicKeyFile = path.join(dkimPath, 'public');

    var publicKey = safe.fs.readFileSync(dkimPublicKeyFile, 'utf8');

    if (publicKey === null) {
        debug('Error reading dkim public key.', safe.error);
        return null;
    }

    // remove header, footer and new lines
    publicKey = publicKey.split('\n').slice(1, -2).join('');

    return publicKey;
}

// NOTE: if you change the SPF record here, be sure the wait check in mailer.js
// https://agari.zendesk.com/hc/en-us/articles/202952749-How-long-can-my-SPF-record-be-
function txtRecordsWithSpf(callback) {
    assert.strictEqual(typeof callback, 'function');

    domains.getDNSRecords('', config.fqdn(), 'TXT', function (error, txtRecords) {
        if (error) return callback(error);

        debug('txtRecordsWithSpf: current txt records - %j', txtRecords);

        var i, matches, validSpf;

        for (i = 0; i < txtRecords.length; i++) {
            matches = txtRecords[i].match(/^("?v=spf1) /); // DO backend may return without quotes
            if (matches === null) continue;

            // this won't work if the entry is arbitrarily "split" across quoted strings
            validSpf = txtRecords[i].indexOf('a:' + config.adminFqdn()) !== -1;
            break; // there can only be one SPF record
        }

        if (validSpf) return callback(null, null);

        if (!matches) { // no spf record was found, create one
            txtRecords.push('"v=spf1 a:' + config.adminFqdn() + ' ~all"');
            debug('txtRecordsWithSpf: adding txt record');
        } else { // just add ourself
            txtRecords[i] = matches[1] + ' a:' + config.adminFqdn() + txtRecords[i].slice(matches[1].length);
            debug('txtRecordsWithSpf: inserting txt record');
        }

        return callback(null, txtRecords);
    });
}

function addDnsRecords(ip, callback) {
    assert.strictEqual(typeof ip, 'string');
    callback = callback || NOOP_CALLBACK;

    if (process.env.BOX_ENV === 'test') return callback();

    var dkimKey = readDkimPublicKeySync();
    if (!dkimKey) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, new Error('Failed to read dkim public key')));

    var webadminRecord = { subdomain: config.adminLocation(), domain: config.fqdn(), type: 'A', values: [ ip ] };
    // t=s limits the domainkey to this domain and not it's subdomains
    var dkimRecord = { subdomain: config.dkimSelector() + '._domainkey', domain: config.fqdn(), type: 'TXT', values: [ '"v=DKIM1; t=s; p=' + dkimKey + '"' ] };

    var records = [ ];
    if (config.isCustomDomain()) {
        records.push(webadminRecord);
        records.push(dkimRecord);
    } else {
        // for non-custom domains, we show a noapp.html page
        var nakedDomainRecord = { subdomain: '', domain: config.fqdn(), type: 'A', values: [ ip ] };

        records.push(nakedDomainRecord);
        records.push(webadminRecord);
        records.push(dkimRecord);
    }

    debug('addDnsRecords: %j', records);

    async.retry({ times: 10, interval: 20000 }, function (retryCallback) {
        txtRecordsWithSpf(function (error, txtRecords) {
            if (error) return retryCallback(error);

            if (txtRecords) records.push({ subdomain: '', domain: config.fqdn(), type: 'TXT', values: txtRecords });

            debug('addDnsRecords: will update %j', records);

            async.mapSeries(records, function (record, iteratorCallback) {
                domains.upsertDNSRecords(record.subdomain, record.domain, record.type, record.values, iteratorCallback);
            }, function (error, changeIds) {
                if (error) debug('addDnsRecords: failed to update : %s. will retry', error);
                else debug('addDnsRecords: records %j added with changeIds %j', records, changeIds);

                retryCallback(error);
            });
        });
    }, function (error) {
        if (error) debug('addDnsRecords: done updating records with error:', error);
        else debug('addDnsRecords: done');

        callback(error);
    });
}

function restore(backupConfig, backupId, version, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!semver.valid(version)) return callback(new CloudronError(CloudronError.BAD_STATE, 'version is not a valid semver'));
    if (semver.major(config.version()) !== semver.major(version) || semver.minor(config.version()) !== semver.minor(version)) return callback(new CloudronError(CloudronError.BAD_STATE, `Run cloudron-setup with --version ${config.version()} to restore from this backup`));

    user.count(function (error, count) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));
        if (count) return callback(new CloudronError(CloudronError.ALREADY_PROVISIONED, 'Already activated'));

        backups.testConfig(backupConfig, function (error) {
            if (error && error.reason === BackupsError.BAD_FIELD) return callback(new CloudronError(CloudronError.BAD_FIELD, error.message));
            if (error && error.reason === BackupsError.EXTERNAL_ERROR) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, error.message));
            if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

            gWebadminStatus.restoring = true;

            backups.restore(backupConfig, backupId, function (error) {
                gWebadminStatus.restoring = false;

                if (error) return debug('Error restoring:', error);

                shell.sudo('restart', [ RESTART_CMD ], NOOP_CALLBACK);
            });

            callback(null); // do no block
        });
    });
}

function reboot(callback) {
    shell.sudo('reboot', [ REBOOT_CMD ], callback);
}

function update(boxUpdateInfo, auditSource, callback) {
    assert.strictEqual(typeof boxUpdateInfo, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!boxUpdateInfo) return callback(null);

    var error = locker.lock(locker.OP_BOX_UPDATE);
    if (error) return callback(new CloudronError(CloudronError.BAD_STATE, error.message));

    eventlog.add(eventlog.ACTION_UPDATE, auditSource, { boxUpdateInfo: boxUpdateInfo });

    // ensure tools can 'wait' on progress
    progress.set(progress.UPDATE, 0, 'Starting');

    // initiate the update/upgrade but do not wait for it
    if (boxUpdateInfo.upgrade) {
        debug('Starting upgrade');
        doUpgrade(boxUpdateInfo, function (error) {
            if (error) {
                debug('Upgrade failed with error:', error);
                locker.unlock(locker.OP_BOX_UPDATE);
            }
        });
    } else {
        debug('Starting update');
        doUpdate(boxUpdateInfo, function (error) {
            if (error) {
                debug('Update failed with error:', error);
                locker.unlock(locker.OP_BOX_UPDATE);
            }
        });
    }

    callback(null);
}


function updateToLatest(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    var boxUpdateInfo = updateChecker.getUpdateInfo().box;
    if (!boxUpdateInfo) return callback(new CloudronError(CloudronError.ALREADY_UPTODATE, 'No update available'));
    if (!boxUpdateInfo.sourceTarballUrl) return callback(new CloudronError(CloudronError.BAD_STATE, 'No automatic update available'));

    // check if this is just a version number change
    if (config.version().match(/[-+]/) !== null && config.version().replace(/[-+].*/, '') === boxUpdateInfo.version) {
        doShortCircuitUpdate(boxUpdateInfo, function (error) {
            if (error) debug('Short-circuit update failed', error);
        });

        return callback(null);
    }

    if (boxUpdateInfo.upgrade && config.provider() !== 'caas') return callback(new CloudronError(CloudronError.SELF_UPGRADE_NOT_SUPPORTED));

    update(boxUpdateInfo, auditSource, callback);
}

function doShortCircuitUpdate(boxUpdateInfo, callback) {
    assert(boxUpdateInfo !== null && typeof boxUpdateInfo === 'object');

    debug('Starting short-circuit from prerelease version %s to release version %s', config.version(), boxUpdateInfo.version);
    config.setVersion(boxUpdateInfo.version);
    progress.clear(progress.UPDATE);
    updateChecker.resetUpdateInfo();
    callback();
}

function doUpgrade(boxUpdateInfo, callback) {
    assert(boxUpdateInfo !== null && typeof boxUpdateInfo === 'object');

    function upgradeError(e) {
        progress.set(progress.UPDATE, -1, e.message);
        callback(e);
    }

    progress.set(progress.UPDATE, 5, 'Backing up for upgrade');

    backups.backupBoxAndApps({ userId: null, username: 'upgrader' }, function (error) {
        if (error) return upgradeError(error);

        superagent.post(config.apiServerOrigin() + '/api/v1/boxes/' + config.fqdn() + '/upgrade')
            .query({ token: config.token() })
            .send({ version: boxUpdateInfo.version })
            .timeout(30 * 1000)
            .end(function (error, result) {
                if (error && !error.response) return upgradeError(new Error('Network error making upgrade request: ' + error));
                if (result.statusCode !== 202) return upgradeError(new Error(util.format('Server not ready to upgrade. statusCode: %s body: %j', result.status, result.body)));

                progress.set(progress.UPDATE, 10, 'Updating base system');

                // no need to unlock since this is the last thing we ever do on this box
                callback();
                retire('upgrade');
            });
    });
}

function doUpdate(boxUpdateInfo, callback) {
    assert(boxUpdateInfo && typeof boxUpdateInfo === 'object');

    function updateError(e) {
        progress.set(progress.UPDATE, -1, e.message);
        callback(e);
    }

    progress.set(progress.UPDATE, 5, 'Backing up for update');

    backups.backupBoxAndApps({ userId: null, username: 'updater' }, function (error) {
        if (error) return updateError(error);

        // NOTE: this data is opaque and will be passed through the installer.sh
        var data= {
            provider: config.provider(),
            token: config.token(),
            apiServerOrigin: config.apiServerOrigin(),
            webServerOrigin: config.webServerOrigin(),
            fqdn: config.fqdn(),
            adminLocation: config.adminLocation(),
            tlsCert: config.tlsCert(),
            tlsKey: config.tlsKey(),
            isCustomDomain: config.isCustomDomain(),
            isDemo: config.isDemo(),
            zoneName: config.zoneName(),

            appstore: {
                token: config.token(),
                apiServerOrigin: config.apiServerOrigin()
            },
            caas: {
                token: config.token(),
                apiServerOrigin: config.apiServerOrigin(),
                webServerOrigin: config.webServerOrigin()
            },

            version: boxUpdateInfo.version
        };

        debug('updating box %s %j', boxUpdateInfo.sourceTarballUrl, _.omit(data, 'tlsCert', 'tlsKey', 'token', 'appstore', 'caas'));

        progress.set(progress.UPDATE, 5, 'Downloading and extracting new version');

        shell.sudo('update', [ UPDATE_CMD, boxUpdateInfo.sourceTarballUrl, JSON.stringify(data) ], function (error) {
            if (error) return updateError(error);

            // Do not add any code here. The installer script will stop the box code any instant
        });
    });
}

function checkDiskSpace(callback) {
    callback = callback || NOOP_CALLBACK;

    debug('Checking disk space');

    getDisks(function (error, disks) {
        if (error) {
            debug('df error %s', error.message);
            return callback();
        }

        df().then(function (entries) {
            /*
                [{
                filesystem: '/dev/disk1',
                size: 499046809600,
                used: 443222245376,
                available: 55562420224,
                capacity: 0.89,
                mountpoint: '/'
            }, ...]
            */
            var oos = entries.some(function (entry) {
                // ignore other filesystems but where box, app and platform data is
                if (entry.filesystem !== disks.boxDataDisk && entry.filesystem !== disks.platformDataDisk && entry.filesystem !== disks.appsDataDisk) return false;

                return (entry.available <= (1.25 * 1024 * 1024 * 1024)); // 1.5G
            });

            debug('Disk space checked. ok: %s', !oos);

            if (oos) mailer.outOfDiskSpace(JSON.stringify(entries, null, 4));

            callback();
        }).catch(function (error) {
            debug('df error %s', error.message);
            mailer.outOfDiskSpace(error.message);
            return callback();
        });
    });
}

function retire(reason, info, callback) {
    assert(reason === 'migrate' || reason === 'upgrade');
    info = info || { };
    callback = callback || NOOP_CALLBACK;

    var data = {
        apiServerOrigin: config.apiServerOrigin(),
        isCustomDomain: config.isCustomDomain(),
        fqdn: config.fqdn()
    };
    shell.sudo('retire', [ RETIRE_CMD, reason, JSON.stringify(info), JSON.stringify(data) ], callback);
}

function doMigrate(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    var error = locker.lock(locker.OP_MIGRATE);
    if (error) return callback(new CloudronError(CloudronError.BAD_STATE, error.message));

    function unlock(error) {
        debug('Failed to migrate', error);
        locker.unlock(locker.OP_MIGRATE);
        progress.set(progress.MIGRATE, -1, 'Backup failed: ' + error.message);
    }

    progress.set(progress.MIGRATE, 10, 'Backing up for migration');

    // initiate the migration in the background
    backups.backupBoxAndApps({ userId: null, username: 'migrator' }, function (error) {
        if (error) return unlock(error);

        debug('migrate: domain: %s size %s region %s', options.domain, options.size, options.region);

        superagent
            .post(config.apiServerOrigin() + '/api/v1/boxes/' + config.fqdn() + '/migrate')
            .query({ token: config.token() })
            .send(options)
            .timeout(30 * 1000)
            .end(function (error, result) {
                if (error && !error.response) return unlock(error); // network error
                if (result.statusCode === 409) return unlock(new CloudronError(CloudronError.BAD_STATE));
                if (result.statusCode === 404) return unlock(new CloudronError(CloudronError.NOT_FOUND));
                if (result.statusCode !== 202) return unlock(new CloudronError(CloudronError.EXTERNAL_ERROR, util.format('%s %j', result.status, result.body)));

                progress.set(progress.MIGRATE, 10, 'Migrating');

                retire('migrate', _.pick(options, 'domain', 'size', 'region'));
            });
    });

    callback(null);
}

function migrate(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (config.isDemo()) return callback(new CloudronError(CloudronError.BAD_FIELD, 'Not allowed in demo mode'));

    if (!options.domain) return doMigrate(options, callback);

    var dnsConfig = _.pick(options, 'domain', 'provider', 'accessKeyId', 'secretAccessKey', 'region', 'endpoint', 'token', 'zoneName');

    domains.get(options.domain, function (error, result) {
        if (error && error.reason !== DomainError.NOT_FOUND) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        var func;
        if (!result) func = domains.add.bind(null, options.domain, options.zoneName, dnsConfig, null);
        else func = domains.update.bind(null, options.domain, dnsConfig, null);

        func(function (error) {
            if (error && error.reason === DomainError.BAD_FIELD) return callback(new CloudronError(CloudronError.BAD_FIELD, error.message));
            if (error) return callback(new SettingsError(CloudronError.INTERNAL_ERROR, error));

            // TODO: should probably rollback dns config if migrate fails
            doMigrate(options, callback);
        });
    });
}

// called for dynamic dns setups where we have to update the IP
function refreshDNS(callback) {
    callback = callback || NOOP_CALLBACK;

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        debug('refreshDNS: current ip %s', ip);

        addDnsRecords(ip, function (error) {
            if (error) return callback(error);

            debug('refreshDNS: done for system records');

            apps.getAll(function (error, result) {
                if (error) return callback(error);

                async.each(result, function (app, callback) {
                    // do not change state of installing apps since apptask will error if dns record already exists
                    if (app.installationState !== appdb.ISTATE_INSTALLED) return callback();

                    domains.upsertDNSRecords(app.location, app.domain, 'A', [ ip ], callback);
                }, function (error) {
                    if (error) return callback(error);

                    debug('refreshDNS: done for apps');

                    callback();
                });
            });
        });
    });
}

function getLogs(options, callback) {
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    var units = options.units || [],
        lines = options.lines || 100,
        format = options.format || 'json',
        follow = !!options.follow;

    assert(Array.isArray(units));
    assert.strictEqual(typeof lines, 'number');
    assert.strictEqual(typeof format, 'string');

    debug('Getting logs for %j', units);

    var args = [ '--no-pager', '--lines=' + lines ];
    units.forEach(function (u) {
        if (u === 'box') args.push('--unit=box');
        else if (u === 'mail') args.push('CONTAINER_NAME=mail');
    });
    if (format === 'short') args.push('--output=short', '-a'); else args.push('--output=json');
    if (follow) args.push('--follow');

    var cp = spawn('/bin/journalctl', args);

    var transformStream = split(function mapper(line) {
        if (format !== 'json') return line + '\n';

        var obj = safe.JSON.parse(line);
        if (!obj) return undefined;

        return JSON.stringify({
            realtimeTimestamp: obj.__REALTIME_TIMESTAMP,
            monotonicTimestamp: obj.__MONOTONIC_TIMESTAMP,
            message: obj.MESSAGE,
            source: obj.SYSLOG_IDENTIFIER || ''
        }) + '\n';
    });

    transformStream.close = cp.kill.bind(cp, 'SIGKILL'); // closing stream kills the child process

    cp.stdout.pipe(transformStream);

    return callback(null, transformStream);
}
