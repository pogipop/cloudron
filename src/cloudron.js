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

    updateToLatest: updateToLatest,
    restore: restore,
    reboot: reboot,

    checkDiskSpace: checkDiskSpace
};

var assert = require('assert'),
    async = require('async'),
    backups = require('./backups.js'),
    BackupsError = require('./backups.js').BackupsError,
    caas = require('./caas.js'),
    certificates = require('./certificates.js'),
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
    mail = require('./mail.js'),
    mailer = require('./mailer.js'),
    nginx = require('./nginx.js'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    platform = require('./platform.js'),
    progress = require('./progress.js'),
    safe = require('safetydance'),
    semver = require('semver'),
    settings = require('./settings.js'),
    settingsdb = require('./settingsdb.js'),
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
    RESTART_CMD = path.join(__dirname, 'scripts/restart.sh');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

var gWebadminStatus = { dns: false, tls: false, configuring: false, restoring: false };

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

    async.series([
        certificates.initialize,
        settings.initialize,
        configureDefaultServer,
        cron.initialize, // required for caas heartbeat before activation
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
        platform.stop,
        certificates.uninitialize,
        settings.uninitialize
    ], callback);
}

function onActivated(callback) {
    callback = callback || NOOP_CALLBACK;

    // Starting the platform after a user is available means:
    // 1. mail bounces can now be sent to the cloudron owner
    // 2. the restore code path can run without sudo (since mail/ is non-root)
    user.count(function (error, count) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));
        if (!count) return callback(); // not activated

        platform.start(callback);
    });
}

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

function dnsSetup(adminFqdn, domain, zoneName, provider, dnsConfig, callback) {
    assert.strictEqual(typeof adminFqdn, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof provider, 'string');
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (config.adminFqdn()) return callback(new CloudronError(CloudronError.ALREADY_SETUP));

    if (!zoneName) zoneName = tld.getDomain(domain) || domain;

    debug('dnsSetup: Setting up Cloudron with domain %s and zone %s', domain, zoneName);

    function done(error) {
        if (error && error.reason === DomainError.BAD_FIELD) return callback(new CloudronError(CloudronError.BAD_FIELD, error.message));
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        autoprovision(function (error) {
            if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

            config.setFqdn(domain); // set fqdn only after dns config is valid, otherwise cannot re-setup if we failed
            config.setAdminFqdn(adminFqdn);
            config.setAdminLocation('my');
            config.setZoneName(zoneName);

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
                mail.add(null, domain)
            ], done);
        } else {
            domains.update(domain, provider, dnsConfig, null /* cert */, done);
        }
    });
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

    nginx.configureAdmin(certFilePath, keyFilePath, 'default.conf', '', function (error) {
        if (error) return callback(error);

        debug('configureDefaultServer: done');

        callback(null);
    });
}

function configureWebadmin(callback) {
    callback = callback || NOOP_CALLBACK;

    debug('configureWebadmin: adminFqdn:%s status:%j', config.adminFqdn(), gWebadminStatus);

    if (process.env.BOX_ENV === 'test' || !config.adminFqdn() || gWebadminStatus.configuring) return callback();

    gWebadminStatus.configuring = true; // re-entracy guard

    function done(error) {
        gWebadminStatus.configuring = false;
        debug('configureWebadmin: done error: %j', error || {});
        callback(error);
    }

    function configureNginx(error) {
        debug('configureNginx: dns update: %j', error || {});

        certificates.ensureCertificate({ domain: config.fqdn(), location: config.adminLocation(), intrinsicFqdn: config.adminFqdn() }, function (error, certFilePath, keyFilePath) {
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

        addWebadminDnsRecord(ip, config.fqdn(), function (error) {
            if (error) return configureNginx(error);

            domains.waitForDNSRecord(config.adminFqdn(), config.fqdn(), ip, 'A', { interval: 30000, times: 50000 }, function (error) {
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
                adminFqdn: config.adminFqdn(),
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

function getConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

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

    caas.getBoxAndUserDetails(function (error, result) {
        if (error) debug('Failed to fetch cloudron details.', error.reason, error.message);

        result = _.extend(BOX_AND_USER_TEMPLATE, result || {});

        settings.getCloudronName(function (error, cloudronName) {
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
                isDemo: config.isDemo(),
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
}

function restore(backupConfig, backupId, version, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!semver.valid(version)) return callback(new CloudronError(CloudronError.BAD_STATE, 'version is not a valid semver'));
    if (semver.major(config.version()) !== semver.major(version) || semver.minor(config.version()) !== semver.minor(version)) return callback(new CloudronError(CloudronError.BAD_STATE, `Run cloudron-setup with --version ${version} to restore from this backup`));

    user.count(function (error, count) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));
        if (count) return callback(new CloudronError(CloudronError.ALREADY_PROVISIONED, 'Already activated'));

        backups.testConfig(backupConfig, function (error) {
            if (error && error.reason === BackupsError.BAD_FIELD) return callback(new CloudronError(CloudronError.BAD_FIELD, error.message));
            if (error && error.reason === BackupsError.EXTERNAL_ERROR) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, error.message));
            if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

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
        caas.upgrade(boxUpdateInfo, function (error) {
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
            apiServerOrigin: config.apiServerOrigin(),
            webServerOrigin: config.webServerOrigin(),
            fqdn: config.fqdn(),
            adminFqdn: config.adminFqdn(),
            adminLocation: config.adminLocation(),
            isDemo: config.isDemo(),
            zoneName: config.zoneName(),

            appstore: {
                apiServerOrigin: config.apiServerOrigin()
            },
            caas: {
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
