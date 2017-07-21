'use strict';

exports = module.exports = {
    SettingsError: SettingsError,

    initialize: initialize,
    uninitialize: uninitialize,

    getEmailStatus: getEmailStatus,

    getAutoupdatePattern: getAutoupdatePattern,
    setAutoupdatePattern: setAutoupdatePattern,

    getTimeZone: getTimeZone,
    setTimeZone: setTimeZone,

    getCloudronName: getCloudronName,
    setCloudronName: setCloudronName,

    getCloudronAvatar: getCloudronAvatar,
    setCloudronAvatar: setCloudronAvatar,

    getDeveloperMode: getDeveloperMode,
    setDeveloperMode: setDeveloperMode,

    getDnsConfig: getDnsConfig,
    setDnsConfig: setDnsConfig,

    getDynamicDnsConfig: getDynamicDnsConfig,
    setDynamicDnsConfig: setDynamicDnsConfig,

    getBackupConfig: getBackupConfig,
    setBackupConfig: setBackupConfig,

    getTlsConfig: getTlsConfig,
    setTlsConfig: setTlsConfig,

    getUpdateConfig: getUpdateConfig,
    setUpdateConfig: setUpdateConfig,

    getAppstoreConfig: getAppstoreConfig,
    setAppstoreConfig: setAppstoreConfig,

    getMailConfig: getMailConfig,
    setMailConfig: setMailConfig,

    setCatchAllAddress: setCatchAllAddress,
    getCatchAllAddress: getCatchAllAddress,

    getDefaultSync: getDefaultSync,
    getEmailDigest: getEmailDigest,
    setEmailDigest: setEmailDigest,

    getAll: getAll,

    AUTOUPDATE_PATTERN_KEY: 'autoupdate_pattern',
    TIME_ZONE_KEY: 'time_zone',
    CLOUDRON_NAME_KEY: 'cloudron_name',
    DEVELOPER_MODE_KEY: 'developer_mode',
    EMAIL_DIGEST: 'email_digest',
    DNS_CONFIG_KEY: 'dns_config',
    DYNAMIC_DNS_KEY: 'dynamic_dns',
    BACKUP_CONFIG_KEY: 'backup_config',
    TLS_CONFIG_KEY: 'tls_config',
    UPDATE_CONFIG_KEY: 'update_config',
    APPSTORE_CONFIG_KEY: 'appstore_config',
    MAIL_CONFIG_KEY: 'mail_config',
    CATCH_ALL_ADDRESS: 'catch_all_address',

    events: null
};

var assert = require('assert'),
    async = require('async'),
    backups = require('./backups.js'),
    BackupsError = backups.BackupsError,
    config = require('./config.js'),
    constants = require('./constants.js'),
    CronJob = require('cron').CronJob,
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:settings'),
    dig = require('./dig.js'),
    cloudron = require('./cloudron.js'),
    CloudronError = cloudron.CloudronError,
    moment = require('moment-timezone'),
    net = require('net'),
    paths = require('./paths.js'),
    platform = require('./platform.js'),
    safe = require('safetydance'),
    settingsdb = require('./settingsdb.js'),
    subdomains = require('./subdomains.js'),
    SubdomainError = subdomains.SubdomainError,
    superagent = require('superagent'),
    sysinfo = require('./sysinfo.js'),
    util = require('util'),
    _ = require('underscore');

var gDefaults = (function () {
    var result = { };
    result[exports.AUTOUPDATE_PATTERN_KEY] = '00 00 1,3,5,23 * * *';
    result[exports.TIME_ZONE_KEY] = 'America/Los_Angeles';
    result[exports.CLOUDRON_NAME_KEY] = 'Cloudron';
    result[exports.DEVELOPER_MODE_KEY] = true;
    result[exports.DYNAMIC_DNS_KEY] = false;
    result[exports.DNS_CONFIG_KEY] = { provider: 'manual' };
    result[exports.BACKUP_CONFIG_KEY] = {
        provider: 'filesystem',
        key: '',
        backupFolder: '/var/backups',
        retentionSecs: 172800
    };
    result[exports.TLS_CONFIG_KEY] = { provider: 'letsencrypt-prod' };
    result[exports.UPDATE_CONFIG_KEY] = { prerelease: false };
    result[exports.APPSTORE_CONFIG_KEY] = {};
    result[exports.MAIL_CONFIG_KEY] = { enabled: false };
    result[exports.CATCH_ALL_ADDRESS] = [ ];
    result[exports.EMAIL_DIGEST] = true;

    return result;
})();

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

function SettingsError(reason, errorOrMessage) {
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
util.inherits(SettingsError, Error);
SettingsError.INTERNAL_ERROR = 'Internal Error';
SettingsError.EXTERNAL_ERROR = 'External Error';
SettingsError.NOT_FOUND = 'Not Found';
SettingsError.BAD_FIELD = 'Bad Field';

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

function getEmailStatus(callback) {
    assert.strictEqual(typeof callback, 'function');

    var digOptions = { server: '127.0.0.1', port: 53, timeout: 5000 };

    var records = {}, outboundPort25 = {};

    var dkimKey = cloudron.readDkimPublicKeySync();
    if (!dkimKey) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, new Error('Failed to read dkim public key')));

    function checkDkim(callback) {
        records.dkim = {
            domain: constants.DKIM_SELECTOR + '._domainkey.' + config.fqdn(),
            type: 'TXT',
            expected: '"v=DKIM1; t=s; p=' + dkimKey + '"',
            value: null,
            status: false
        };

        dig.resolve(records.dkim.domain, records.dkim.type, digOptions, function (error, txtRecords) {
            if (error && error.code === 'ENOTFOUND') return callback(null);    // not setup
            if (error) return callback(error);

            if (Array.isArray(txtRecords) && txtRecords.length !== 0) {
                records.dkim.value = txtRecords[0];
                records.dkim.status = (records.dkim.value === records.dkim.expected);
            }

            callback();
        });
    }

    function checkSpf(callback) {
        records.spf = {
            domain: config.fqdn(),
            type: 'TXT',
            value: null,
            expected: '"v=spf1 a:' + config.adminFqdn() + ' ~all"',
            status: false
        };

        // https://agari.zendesk.com/hc/en-us/articles/202952749-How-long-can-my-SPF-record-be-
        dig.resolve(records.spf.domain, records.spf.type, digOptions, function (error, txtRecords) {
            if (error && error.code === 'ENOTFOUND') return callback(null);    // not setup
            if (error) return callback(error);

            if (!Array.isArray(txtRecords)) return callback();

            var i;
            for (i = 0; i < txtRecords.length; i++) {
                if (txtRecords[i].indexOf('"v=spf1 ') !== 0) continue; // not SPF
                records.spf.value = txtRecords[i];
                records.spf.status = records.spf.value.indexOf(' a:' + config.adminFqdn()) !== -1;
                break;
            }

            if (records.spf.status) {
                records.spf.expected = records.spf.value;
            } else if (i !== txtRecords.length) {
                records.spf.expected = '"v=spf1 a:' + config.adminFqdn() + ' ' + records.spf.value.slice('"v=spf1 '.length);
            }

            callback();
        });
    }

    function checkMx(callback) {
        records.mx = {
            domain: config.fqdn(),
            type: 'MX',
            value: null,
            expected: '10 ' + config.mailFqdn() + '.',
            status: false
        };

        dig.resolve(records.mx.domain, records.mx.type, digOptions, function (error, mxRecords) {
            if (error && error.code === 'ENOTFOUND') return callback(null);    // not setup
            if (error) return callback(error);

            if (Array.isArray(mxRecords) && mxRecords.length !== 0) {
                records.mx.status = mxRecords.length == 1 && mxRecords[0].exchange === (config.mailFqdn() + '.');
                records.mx.value = mxRecords.map(function (r) { return r.priority + ' ' + r.exchange; }).join(' ');
            }

            callback();
        });
    }

    function checkDmarc(callback) {
        records.dmarc = {
            domain: '_dmarc.' + config.fqdn(),
            type: 'TXT',
            value: null,
            expected: '"v=DMARC1; p=reject; pct=100"',
            status: false
        };

        dig.resolve(records.dmarc.domain, records.dmarc.type, digOptions, function (error, txtRecords) {
            if (error && error.code === 'ENOTFOUND') return callback(null);    // not setup
            if (error) return callback(error);

            if (Array.isArray(txtRecords) && txtRecords.length !== 0) {
                records.dmarc.value = txtRecords[0];
                records.dmarc.status = (records.dmarc.value === records.dmarc.expected);
            }

            callback();
        });
    }

    function checkPtr(callback) {
        records.ptr = {
            domain: null,
            type: 'PTR',
            value: null,
            expected: config.mailFqdn() + '.',
            status: false
        };

        sysinfo.getPublicIp(function (error, ip) {
            if (error) return callback(error);

            records.ptr.domain = ip.split('.').reverse().join('.') + '.in-addr.arpa';

            dig.resolve(ip, 'PTR', digOptions, function (error, ptrRecords) {
                if (error && error.code === 'ENOTFOUND') return callback(null);    // not setup
                if (error) return callback(error);

                if (Array.isArray(ptrRecords) && ptrRecords.length !== 0) {
                    records.ptr.value = ptrRecords.join(' ');
                    records.ptr.status = ptrRecords.some(function (v) { return v === records.ptr.expected; });
                }

                return callback();
            });
        });
    }

    function checkOutbound25(callback) {
        assert.strictEqual(typeof callback, 'function');

        var smtpServer = _.sample([
            'smtp.gmail.com',
            'smtp.live.com',
            'smtp.mail.yahoo.com',
            'smtp.o2.ie',
            'smtp.comcast.net',
            'outgoing.verizon.net'
        ]);

        outboundPort25 = {
            value: 'OK',
            status: false
        };

        var client = new net.Socket();
        client.setTimeout(5000);
        client.connect(25, smtpServer);
        client.on('connect', function () {
            outboundPort25.status = true;
            outboundPort25.value = 'OK';
            client.destroy(); // do not use end() because it still triggers timeout
            callback();
        });
        client.on('timeout', function () {
            outboundPort25.status = false;
            outboundPort25.value = 'Connect to ' + smtpServer + ' timed out';
            client.destroy();
            callback(new Error('Timeout'));
        });
        client.on('error', function (error) {
            outboundPort25.status = false;
            outboundPort25.value = 'Connect to ' + smtpServer + ' failed: ' + error.message;
            client.destroy();
            callback(error);
        });
    }

    function ignoreError(what, func) {
        return function (callback) {
            func(function (error) {
                if (error) debug('Ignored error - ' + what + ':', error);

                callback();
            });
        };
    }

    async.parallel([
        ignoreError('mx', checkMx),
        ignoreError('spf', checkSpf),
        ignoreError('dmarc', checkDmarc),
        ignoreError('dkim', checkDkim),
        ignoreError('ptr', checkPtr),
        ignoreError('port25', checkOutbound25)
    ], function () {
        callback(null, { dns: records, outboundPort25: outboundPort25 } );
    });
}

function setAutoupdatePattern(pattern, callback) {
    assert.strictEqual(typeof pattern, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (pattern !== constants.AUTOUPDATE_PATTERN_NEVER) { // check if pattern is valid
        var job = safe.safeCall(function () { return new CronJob(pattern); });
        if (!job) return callback(new SettingsError(SettingsError.BAD_FIELD, 'Invalid pattern'));
    }

    settingsdb.set(exports.AUTOUPDATE_PATTERN_KEY, pattern, function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        exports.events.emit(exports.AUTOUPDATE_PATTERN_KEY, pattern);

        return callback(null);
    });
}

function getAutoupdatePattern(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.AUTOUPDATE_PATTERN_KEY, function (error, pattern) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.AUTOUPDATE_PATTERN_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, pattern);
    });
}

function setTimeZone(tz, callback) {
    assert.strictEqual(typeof tz, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (moment.tz.names().indexOf(tz) === -1) return callback(new SettingsError(SettingsError.BAD_FIELD, 'Bad timeZone'));

    settingsdb.set(exports.TIME_ZONE_KEY, tz, function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        exports.events.emit(exports.TIME_ZONE_KEY, tz);

        return callback(null);
    });
}

function getTimeZone(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.TIME_ZONE_KEY, function (error, tz) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.TIME_ZONE_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, tz);
    });
}

function getCloudronName(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.CLOUDRON_NAME_KEY, function (error, name) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.CLOUDRON_NAME_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));
        callback(null, name);
    });
}

function setCloudronName(name, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!name) return callback(new SettingsError(SettingsError.BAD_FIELD, 'name is empty'));

    // some arbitrary restrictions (for sake of ui layout)
    if (name.length > 32) return callback(new SettingsError(SettingsError.BAD_FIELD, 'name cannot exceed 32 characters'));

    settingsdb.set(exports.CLOUDRON_NAME_KEY, name, function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        exports.events.emit(exports.CLOUDRON_NAME_KEY, name);

        return callback(null);
    });
}

function getCloudronAvatar(callback) {
    assert.strictEqual(typeof callback, 'function');

    var avatar = safe.fs.readFileSync(paths.CLOUDRON_AVATAR_FILE);
    if (avatar) return callback(null, avatar);

    // try default fallback
    avatar = safe.fs.readFileSync(paths.CLOUDRON_DEFAULT_AVATAR_FILE);
    if (avatar) return callback(null, avatar);

    callback(new SettingsError(SettingsError.INTERNAL_ERROR, safe.error));
}

function setCloudronAvatar(avatar, callback) {
    assert(util.isBuffer(avatar));
    assert.strictEqual(typeof callback, 'function');

    if (!safe.fs.writeFileSync(paths.CLOUDRON_AVATAR_FILE, avatar)) {
        return callback(new SettingsError(SettingsError.INTERNAL_ERROR, safe.error));
    }

    return callback(null);
}

function getDeveloperMode(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.DEVELOPER_MODE_KEY, function (error, enabled) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.DEVELOPER_MODE_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        // settingsdb holds string values only
        callback(null, !!enabled);
    });
}

function setDeveloperMode(enabled, callback) {
    assert.strictEqual(typeof enabled, 'boolean');
    assert.strictEqual(typeof callback, 'function');

    // settingsdb takes string values only
    settingsdb.set(exports.DEVELOPER_MODE_KEY, enabled ? 'enabled' : '', function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        exports.events.emit(exports.DEVELOPER_MODE_KEY, enabled);

        return callback(null);
    });
}

function getDnsConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.DNS_CONFIG_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.DNS_CONFIG_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value));
    });
}

function setDnsConfig(dnsConfig, domain, zoneName, callback) {
    assert.strictEqual(typeof dnsConfig, 'object');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof callback, 'function');

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, 'Error getting IP:' + error.message));

        subdomains.verifyDnsConfig(dnsConfig, domain, zoneName, ip, function (error, result) {
            if (error && error.reason === SubdomainError.ACCESS_DENIED) return callback(new SettingsError(SettingsError.BAD_FIELD, 'Error adding A record. Access denied'));
            if (error && error.reason === SubdomainError.NOT_FOUND) return callback(new SettingsError(SettingsError.BAD_FIELD, 'Zone not found'));
            if (error && error.reason === SubdomainError.EXTERNAL_ERROR) return callback(new SettingsError(SettingsError.BAD_FIELD, 'Error adding A record:' + error.message));
            if (error && error.reason === SubdomainError.BAD_FIELD) return callback(new SettingsError(SettingsError.BAD_FIELD, error.message));
            if (error && error.reason === SubdomainError.INVALID_PROVIDER) return callback(new SettingsError(SettingsError.BAD_FIELD, error.message));
            if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

            settingsdb.set(exports.DNS_CONFIG_KEY, JSON.stringify(result), function (error) {
                if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

                exports.events.emit(exports.DNS_CONFIG_KEY, dnsConfig);

                cloudron.configureWebadmin(NOOP_CALLBACK); // do not block

                callback(null);
            });
        });
    });
}

function getDynamicDnsConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.DYNAMIC_DNS_KEY, function (error, enabled) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.DYNAMIC_DNS_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        // settingsdb holds string values only
        callback(null, !!enabled);
    });
}

function setDynamicDnsConfig(enabled, callback) {
    assert.strictEqual(typeof enabled, 'boolean');
    assert.strictEqual(typeof callback, 'function');

    // settingsdb takes string values only
    settingsdb.set(exports.DYNAMIC_DNS_KEY, enabled ? 'enabled' : '', function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        exports.events.emit(exports.DYNAMIC_DNS_KEY, enabled);

        return callback(null);
    });
}

function getTlsConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.TLS_CONFIG_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.TLS_CONFIG_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value)); // provider
    });
}

function setTlsConfig(tlsConfig, callback) {
    assert.strictEqual(typeof tlsConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (tlsConfig.provider !== 'fallback' && tlsConfig.provider !== 'caas' && tlsConfig.provider.indexOf('le-') !== 0) {
        return callback(new SettingsError(SettingsError.BAD_FIELD, 'provider must be caas, fallback or le-*'));
    }

    settingsdb.set(exports.TLS_CONFIG_KEY, JSON.stringify(tlsConfig), function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        exports.events.emit(exports.TLS_CONFIG_KEY, tlsConfig);

        callback(null);
    });
}

function getBackupConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.BACKUP_CONFIG_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.BACKUP_CONFIG_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value)); // provider, token, key, region, prefix, bucket
    });
}

function setBackupConfig(backupConfig, callback) {
    assert.strictEqual(typeof backupConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    backups.testConfig(backupConfig, function (error) {
        if (error && error.reason === BackupsError.BAD_FIELD) return callback(new SettingsError(SettingsError.BAD_FIELD, error.message));
        if (error && error.reason === BackupsError.EXTERNAL_ERROR) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, error.message));
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        settingsdb.set(exports.BACKUP_CONFIG_KEY, JSON.stringify(backupConfig), function (error) {
            if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

            exports.events.emit(exports.BACKUP_CONFIG_KEY, backupConfig);

            callback(null);
        });
    });
}

function getUpdateConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.UPDATE_CONFIG_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.UPDATE_CONFIG_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value)); // { prerelease }
    });
}

function setUpdateConfig(updateConfig, callback) {
    assert.strictEqual(typeof updateConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    settingsdb.set(exports.UPDATE_CONFIG_KEY, JSON.stringify(updateConfig), function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        exports.events.emit(exports.UPDATE_CONFIG_KEY, updateConfig);

        callback(null);
    });
}

function getMailConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.MAIL_CONFIG_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.MAIL_CONFIG_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value));
    });
}

function setMailConfig(mailConfig, callback) {
    assert.strictEqual(typeof mailConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    settingsdb.set(exports.MAIL_CONFIG_KEY, JSON.stringify(mailConfig), function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        exports.events.emit(exports.MAIL_CONFIG_KEY, mailConfig);

        callback(null);
    });
}

function getEmailDigest(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.EMAIL_DIGEST, function (error, enabled) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.EMAIL_DIGEST]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, !!enabled); // settingsdb holds string values only
    });
}

function setEmailDigest(enabled, callback) {
    assert.strictEqual(typeof enabled, 'boolean');
    assert.strictEqual(typeof callback, 'function');

    settingsdb.set(exports.EMAIL_DIGEST, enabled ? 'enabled' : '', function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        exports.events.emit(exports.EMAIL_DIGEST, enabled);

        callback(null);
    });
}

function getCatchAllAddress(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.CATCH_ALL_ADDRESS_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.CATCH_ALL_ADDRESS_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value));
    });
}

function setCatchAllAddress(address, callback) {
    assert(Array.isArray(address));
    assert.strictEqual(typeof callback, 'function');

    settingsdb.set(exports.CATCH_ALL_ADDRESS, JSON.stringify(address), function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        exports.events.emit(exports.CATCH_ALL_ADDRESS, address);

        platform.createMailConfig(NOOP_CALLBACK);

        callback(null);
    });
}

function getAppstoreConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.APPSTORE_CONFIG_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.APPSTORE_CONFIG_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value));
    });
}

function setAppstoreConfig(appstoreConfig, callback) {
    assert.strictEqual(typeof appstoreConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    getAppstoreConfig(function (error, oldConfig) {
        if (error) return callback(error);

        var cloudronId = oldConfig.cloudronId;

        function setNewConfig() {
            var data = {
                userId: appstoreConfig.userId,
                token: appstoreConfig.token,
                cloudronId: cloudronId
            };

            settingsdb.set(exports.APPSTORE_CONFIG_KEY, JSON.stringify(data), function (error) {
                if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

                exports.events.emit(exports.APPSTORE_CONFIG_KEY, appstoreConfig);

                callback(null);
            });
        }

        function registerCloudron() {
            const url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons';
            const data = {
                domain: config.fqdn()
            };

            superagent.post(url).send(data).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
                if (error && !error.response) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, error.message));
                if (result.statusCode === 401) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, 'invalid appstore token'));
                if (result.statusCode !== 201) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, 'unable to register cloudron'));

                cloudronId = result.body.cloudron.id;

                setNewConfig();
            });
        }

        if (!cloudronId) return registerCloudron();

        // verify that cloudron belongs to this user
        const url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + oldConfig.cloudronId;
        superagent.get(url).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, error.message));
            if (result.statusCode === 401) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, 'invalid appstore token'));
            if (result.statusCode === 403) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, 'wrong user'));
            if (result.statusCode === 404) return registerCloudron();
            if (result.statusCode !== 200) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, 'unknown error'));

            setNewConfig();
        });
    });

}

function getDefaultSync(name) {
    assert.strictEqual(typeof name, 'string');

    return gDefaults[name];
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.getAll(function (error, settings) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        var result = _.extend({ }, gDefaults);
        settings.forEach(function (setting) { result[setting.name] = setting.value; });

        // convert booleans
        result[exports.DEVELOPER_MODE_KEY] = !!result[exports.DEVELOPER_MODE_KEY];
        result[exports.DYNAMIC_DNS_KEY] = !!result[exports.DYNAMIC_DNS_KEY];

        // convert JSON objects
        [exports.DNS_CONFIG_KEY, exports.TLS_CONFIG_KEY, exports.BACKUP_CONFIG_KEY, exports.MAIL_CONFIG_KEY].forEach(function (key) {
            result[key] = typeof result[key] === 'object' ? result[key] : safe.JSON.parse(result[key]);
        });

        callback(null, result);
    });
}
