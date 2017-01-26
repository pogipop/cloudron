'use strict';

exports = module.exports = {
    CloudronError: CloudronError,

    initialize: initialize,
    uninitialize: uninitialize,
    activate: activate,
    getConfig: getConfig,
    getStatus: getStatus,
    dnsSetup: dnsSetup,

    sendHeartbeat: sendHeartbeat,
    sendAliveStatus: sendAliveStatus,

    updateToLatest: updateToLatest,
    reboot: reboot,
    retire: retire,
    migrate: migrate,

    getConfigStateSync: getConfigStateSync,

    checkDiskSpace: checkDiskSpace,

    readDkimPublicKeySync: readDkimPublicKeySync,
    refreshDNS: refreshDNS,

    events: new (require('events').EventEmitter)(),
    EVENT_ACTIVATED: 'activated'
};

var apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    backups = require('./backups.js'),
    certificates = require('./certificates.js'),
    child_process = require('child_process'),
    clients = require('./clients.js'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    cron = require('./cron.js'),
    debug = require('debug')('box:cloudron'),
    df = require('node-df'),
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
    subdomains = require('./subdomains.js'),
    superagent = require('superagent'),
    sysinfo = require('./sysinfo.js'),
    taskmanager = require('./taskmanager.js'),
    tokendb = require('./tokendb.js'),
    updateChecker = require('./updatechecker.js'),
    user = require('./user.js'),
    UserError = user.UserError,
    user = require('./user.js'),
    util = require('util'),
    _ = require('underscore');

var REBOOT_CMD = path.join(__dirname, 'scripts/reboot.sh'),
    UPDATE_CMD = path.join(__dirname, 'scripts/update.sh'),
    RETIRE_CMD = path.join(__dirname, 'scripts/retire.sh');

var IP_BASED_SETUP_NAME = 'ip_based_setup'; // This will be used for cert and nginx config file names

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

var gUpdatingDns = false,                // flag for dns update reentrancy
    gBoxAndUserDetails = null,         // cached cloudron details like region,size...
    gConfigState = { dns: false, tls: false, configured: false };

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

    async.series([
        installAppBundle,
        checkConfigState,
        configurePlainIP
    ], callback);
}

function uninitialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    platform.events.removeListener(platform.EVENT_READY, onPlatformReady);

    async.series([
        cron.uninitialize,
        taskmanager.pauseTasks,
        mailer.stop,
        platform.uninitialize
    ], callback);
}

function onConfigured(callback) {
    callback = callback || NOOP_CALLBACK;

    // if we hit here, the domain has to be set, this is a logic issue if it isn't
    assert(config.fqdn());

    debug('onConfigured: current state: %j', gConfigState);

    if (gConfigState.configured) return callback(); // re-entracy flag

    gConfigState.configured = true;

    platform.events.on(platform.EVENT_READY, onPlatformReady);

    async.series([
        clients.addDefaultClients,
        cron.initialize,
        certificates.ensureFallbackCertificate,
        platform.initialize, // requires fallback certs for mail container
        addDnsRecords,
        configureAdmin,
        mailer.start
    ], callback);
}

function onPlatformReady(callback) {
    callback = callback || NOOP_CALLBACK;

    debug('onPlatformReady');

    async.series([
        taskmanager.resumeTasks
    ], callback);
}

function getConfigStateSync() {
    return gConfigState;
}

function checkConfigState(callback) {
    callback = callback || NOOP_CALLBACK;

    if (!config.fqdn()) {
        settings.events.once(settings.DNS_CONFIG_KEY, function () { checkConfigState(); }); // check again later
        return callback(null);
    }

    debug('checkConfigState: configured');

    onConfigured(callback);
}

function dnsSetup(dnsConfig, domain, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (config.fqdn()) return callback(new CloudronError(CloudronError.ALREADY_SETUP));

    settings.setDnsConfig(dnsConfig, domain, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return callback(new CloudronError(CloudronError.BAD_FIELD, error.message));
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        config.set('fqdn', domain); // set fqdn only after dns config is valid, otherwise cannot re-setup if we failed

        onConfigured(); // do not block

        callback();
    });
}

function configurePlainIP(callback) {
    callback = callback || NOOP_CALLBACK;

    if (process.env.BOX_ENV === 'test') return callback();

    debug('configurePlainIP');

    sysinfo.getIp(function (error, ip) {
        if (error) return callback(error);

        var certFilePath = path.join(paths.NGINX_CERT_DIR, IP_BASED_SETUP_NAME + '-' + ip + '.cert');
        var keyFilePath = path.join(paths.NGINX_CERT_DIR, IP_BASED_SETUP_NAME + '-' + ip + '.key');

        // check if we already have a cert for this IP, otherwise create one, this is mostly useful for servers with changing IPs
        if (!fs.existsSync(certFilePath) || !fs.existsSync(keyFilePath)) {
            debug('configurePlainIP: create new cert for %s', ip);

            var certCommand = util.format('openssl req -x509 -newkey rsa:2048 -keyout %s -out %s -days 3650 -subj /CN=%s -nodes', keyFilePath, certFilePath, ip);
            safe.child_process.execSync(certCommand);
        }

        // always create a configuration for the ip
        nginx.configureAdmin(certFilePath, keyFilePath, IP_BASED_SETUP_NAME + '.conf', '', function (error) {
            if (error) return callback(error);

            debug('configurePlainIP: done');

            callback(null);
        });
    });
}

function configureAdmin(callback) {
    callback = callback || NOOP_CALLBACK;

    if (process.env.BOX_ENV === 'test') return callback();

    debug('configureAdmin');

    sysinfo.getIp(function (error, ip) {
        if (error) return callback(error);

        subdomains.waitForDns(config.adminFqdn(), ip, 'A', { interval: 30000, times: 50000 }, function (error) {
            if (error) return callback(error);

            gConfigState.dns = true;

            certificates.ensureCertificate({ location: constants.ADMIN_LOCATION }, function (error, certFilePath, keyFilePath) {
                if (error) { // currently, this can never happen
                    debug('Error obtaining certificate. Proceed anyway', error);
                    return callback();
                }

                gConfigState.tls = true;

                nginx.configureAdmin(certFilePath, keyFilePath, constants.NGINX_ADMIN_CONFIG_FILE_NAME, config.adminFqdn(), callback);
            });
        });
    });
}

function setTimeZone(ip, callback) {
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('setTimeZone ip:%s', ip);

    // https://github.com/bluesmoon/node-geoip
    // https://github.com/runk/node-maxmind
    // { url: 'http://freegeoip.net/json/%s', jpath: 'time_zone' },
    // { url: 'http://ip-api.com/json/%s', jpath: 'timezone' },
    // { url: 'http://geoip.nekudo.com/api/%s', jpath: 'time_zone }

    superagent.get('http://ip-api.com/json/' + ip).timeout(10 * 1000).end(function (error, result) {
        if ((error && !error.response) || result.statusCode !== 200) {
            debug('Failed to get geo location: %s', error.message);
            return callback(null);
        }

        if (!result.body.timezone || typeof result.body.timezone !== 'string') {
            debug('No timezone in geoip response : %j', result.body);
            return callback(null);
        }

        debug('Setting timezone to ', result.body.timezone);

        settings.setTimeZone(result.body.timezone, callback);
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

                exports.events.emit(exports.EVENT_ACTIVATED);

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
                boxVersionsUrl: config.get('boxVersionsUrl'),
                apiServerOrigin: config.apiServerOrigin(), // used by CaaS tool
                provider: config.provider(),
                cloudronName: cloudronName,
                adminFqdn: config.fqdn() ? config.adminFqdn() : null,
                configState: gConfigState
            });
        });
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
                    isDev: config.isDev(),
                    fqdn: config.fqdn(),
                    version: config.version(),
                    update: updateChecker.getUpdateInfo(),
                    progress: progress.get(),
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

function sendHeartbeat() {
    if (config.provider() !== 'caas') return;

    var url = config.apiServerOrigin() + '/api/v1/boxes/' + config.fqdn() + '/heartbeat';
    superagent.post(url).query({ token: config.token(), version: config.version() }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) debug('Network error sending heartbeat.', error);
        else if (result.statusCode !== 200) debug('Server responded to heartbeat with %s %s', result.statusCode, result.text);
        else debug('Heartbeat sent to %s', url);
    });
}

function sendAliveStatus(callback) {
    if (typeof callback !== 'function') {
        callback = function (error) {
            if (error && error.reason !== CloudronError.INTERNAL_ERROR) console.error(error);
            else if (error) debug(error);
        };
    }

    function sendAliveStatusWithAppstoreConfig(backendSettings, appstoreConfig) {
        assert.strictEqual(typeof backendSettings, 'object');
        assert.strictEqual(typeof appstoreConfig.userId, 'string');
        assert.strictEqual(typeof appstoreConfig.cloudronId, 'string');
        assert.strictEqual(typeof appstoreConfig.token, 'string');

        var url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + appstoreConfig.cloudronId;
        var data = {
            domain: config.fqdn(),
            version: config.version(),
            provider: config.provider(),
            backendSettings: backendSettings
        };

        superagent.post(url).send(data).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, error));
            if (result.statusCode === 404) return callback(new CloudronError(CloudronError.NOT_FOUND));
            if (result.statusCode !== 201) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, util.format('Sending alive status failed. %s %j', result.status, result.body)));

            callback(null);
        });
    }

    settings.getAll(function (error, result) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        var backendSettings = {
            dnsConfig: {
                provider: result[settings.DNS_CONFIG_KEY].provider,
                wildcard: result[settings.DNS_CONFIG_KEY].provider === 'manual' ? result[settings.DNS_CONFIG_KEY].wildcard : undefined
            },
            tlsConfig: {
                provider: result[settings.TLS_CONFIG_KEY].provider
            },
            backupConfig: {
                provider: result[settings.BACKUP_CONFIG_KEY].provider
            },
            mailConfig: {
                enabled: result[settings.MAIL_CONFIG_KEY].enabled
            }
        };

        // Caas Cloudrons do not store appstore credentials in their local database
        if (config.provider() === 'caas') {
            var url = config.apiServerOrigin() + '/api/v1/exchangeBoxTokenWithUserToken';
            superagent.post(url).query({ token: config.token() }).timeout(30 * 1000).end(function (error, result) {
                if (error && !error.response) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, error));
                if (result.statusCode !== 201) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, util.format('App purchase failed. %s %j', result.status, result.body)));

                sendAliveStatusWithAppstoreConfig(backendSettings, result.body);
            });
        } else {
            settings.getAppstoreConfig(function (error, result) {
                if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

                if (!result.token) {
                    debug('sendAliveStatus: Cloudron not yet registered');
                    return callback(null);
                }

                sendAliveStatusWithAppstoreConfig(backendSettings, result);
            });
        }
    });
}

function readDkimPublicKeySync() {
    if (!config.fqdn()) {
        debug('Cannot read dkim public key without a domain.', safe.error);
        return null;
    }

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
function txtRecordsWithSpf(callback) {
    assert.strictEqual(typeof callback, 'function');

    subdomains.get('', 'TXT', function (error, txtRecords) {
        if (error) return callback(error);

        debug('txtRecordsWithSpf: current txt records - %j', txtRecords);

        var i, validSpf;

        for (i = 0; i < txtRecords.length; i++) {
            if (txtRecords[i].indexOf('"v=spf1 ') !== 0) continue; // not SPF

            validSpf = txtRecords[i].indexOf(' a:' + config.adminFqdn() + ' ') !== -1;
            break;
        }

        if (validSpf) return callback(null, null);

        if (i == txtRecords.length) {
            txtRecords[i] = '"v=spf1 a:' + config.adminFqdn() + ' ~all"';
        } else {
            txtRecords[i] = '"v=spf1 a:' + config.adminFqdn() + ' ' + txtRecords[i].slice('"v=spf1 '.length);
        }

        return callback(null, txtRecords);
    });
}

function addDnsRecords(callback) {
    callback = callback || NOOP_CALLBACK;

    if (process.env.BOX_ENV === 'test') return callback();

    if (gUpdatingDns) {
        debug('addDnsRecords: dns update already in progress');
        return callback();
    }
    gUpdatingDns = true;

    var dkimKey = readDkimPublicKeySync();
    if (!dkimKey) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, new Error('Failed to read dkim public key')));

    sysinfo.getIp(function (error, ip) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        var webadminRecord = { subdomain: constants.ADMIN_LOCATION, type: 'A', values: [ ip ] };
        // t=s limits the domainkey to this domain and not it's subdomains
        var dkimRecord = { subdomain: constants.DKIM_SELECTOR + '._domainkey', type: 'TXT', values: [ '"v=DKIM1; t=s; p=' + dkimKey + '"' ] };

        var records = [ ];
        if (config.isCustomDomain()) {
            records.push(webadminRecord);
            records.push(dkimRecord);
        } else {
            // for non-custom domains, we show a noapp.html page
            var nakedDomainRecord = { subdomain: '', type: 'A', values: [ ip ] };

            records.push(nakedDomainRecord);
            records.push(webadminRecord);
            records.push(dkimRecord);
        }

        debug('addDnsRecords: %j', records);

        async.retry({ times: 10, interval: 20000 }, function (retryCallback) {
            txtRecordsWithSpf(function (error, txtRecords) {
                if (error) return retryCallback(error);

                if (txtRecords) records.push({ subdomain: '', type: 'TXT', values: txtRecords });

                debug('addDnsRecords: will update %j', records);

                async.mapSeries(records, function (record, iteratorCallback) {
                    subdomains.upsert(record.subdomain, record.type, record.values, iteratorCallback);
                }, function (error, changeIds) {
                    if (error) debug('addDnsRecords: failed to update : %s. will retry', error);
                    else debug('addDnsRecords: records %j added with changeIds %j', records, changeIds);

                    retryCallback(error);
                });
            });
        }, function (error) {
            gUpdatingDns = false;

            debug('addDnsRecords: done updating records with error:', error);

            callback(error);
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
                console.error('Upgrade failed with error:', error);
                locker.unlock(locker.OP_BOX_UPDATE);
            }
        });
    } else {
        debug('Starting update');
        doUpdate(boxUpdateInfo, function (error) {
            if (error) {
                console.error('Update failed with error:', error);
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
            tlsCert: config.tlsCert(),
            tlsKey: config.tlsKey(),
            isCustomDomain: config.isCustomDomain(),
            isDemo: config.isDemo(),

            appstore: {
                token: config.token(),
                apiServerOrigin: config.apiServerOrigin()
            },
            caas: {
                token: config.token(),
                apiServerOrigin: config.apiServerOrigin(),
                webServerOrigin: config.webServerOrigin()
            },

            version: boxUpdateInfo.version,
            boxVersionsUrl: config.get('boxVersionsUrl')
        };

        debug('updating box %s %j', boxUpdateInfo.sourceTarballUrl, data);

        progress.set(progress.UPDATE, 5, 'Downloading and extracting new version');

        shell.sudo('update', [ UPDATE_CMD, boxUpdateInfo.sourceTarballUrl, JSON.stringify(data) ], function (error) {
            if (error) return updateError(error);

            // Do not add any code here. The installer script will stop the box code any instant
        });
    });
}

function installAppBundle(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (fs.existsSync(paths.FIRST_RUN_FILE)) return callback();

    var bundle = config.get('appBundle');
    debug('initialize: installing app bundle on first run: %j', bundle);

    if (!bundle || bundle.length === 0) return callback();

    async.eachSeries(bundle, function (appInfo, iteratorCallback) {
        debug('autoInstall: installing %s at %s', appInfo.appstoreId, appInfo.location);

        var data = {
            appStoreId: appInfo.appstoreId,
            location: appInfo.location,
            portBindings: appInfo.portBindings || null,
            accessRestriction: appInfo.accessRestriction || null,
        };

        apps.install(data, { userId: null, username: 'autoinstaller' }, iteratorCallback);
    }, function (error) {
        if (error) debug('autoInstallApps: ', error);

        fs.writeFileSync(paths.FIRST_RUN_FILE, 'been there, done that', 'utf8');

        callback();
    });
}

function checkDiskSpace(callback) {
    callback = callback || NOOP_CALLBACK;

    debug('Checking disk space');

    df(function (error, entries) {
        if (error) {
            debug('df error %s', error.message);
            mailer.outOfDiskSpace(error.message);
            return callback();
        }

        var oos = entries.some(function (entry) {
            return (entry.mount === paths.DATA_DIR && entry.capacity >= 0.90) ||
                   (entry.mount === '/' && entry.available <= (1.25 * 1024 * 1024)); // 1.5G
        });

        debug('Disk space checked. ok: %s', !oos);

        if (oos) mailer.outOfDiskSpace(JSON.stringify(entries, null, 4));

        callback();
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
    backups.backupBoxAndApps({ userId: null, username: 'migrator' }, function (error, backupId) {
        if (error) return unlock(error);

        debug('migrate: domain: %s size %s region %s', options.domain, options.size, options.region);

        options.restoreKey = backupId;

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

    var dnsConfig = _.pick(options, 'domain', 'provider', 'accessKeyId', 'secretAccessKey', 'region', 'endpoint', 'token');

    settings.setDnsConfig(dnsConfig, options.domain, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return callback(new CloudronError(CloudronError.BAD_FIELD, error.message));
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        // TODO: should probably rollback dns config if migrate fails
        doMigrate(options, callback);
    });
}

function refreshDNS(callback) {
    callback = callback || NOOP_CALLBACK;

    sysinfo.getIp(function (error, ip) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        debug('refreshDNS: current ip %s', ip);

        addDnsRecords(function (error) {
            if (error) return callback(error);

            debug('refreshDNS: done for system records');

            apps.getAll(function (error, result) {
                if (error) return callback(error);

                async.each(result, function (app, callback) {
                    // get the current record before updating it
                    subdomains.get(app.location, 'A', function (error, values) {
                        if (error) return callback(error);

                        // refuse to update any existing DNS record for custom domains that we did not create
                        if (values.length !== 0 && !app.dnsRecordId) return callback(null, new Error('DNS Record already exists'));

                        subdomains.upsert(app.location, 'A', [ ip ], callback);
                    });
                }, function (error) {
                    if (error) return callback(error);

                    debug('refreshDNS: done for apps');

                    callback();
                });
            });
        });
    });
}
