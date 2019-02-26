'use strict';

exports = module.exports = {
    SettingsError: SettingsError,

    getAppAutoupdatePattern: getAppAutoupdatePattern,
    setAppAutoupdatePattern: setAppAutoupdatePattern,

    getBoxAutoupdatePattern: getBoxAutoupdatePattern,
    setBoxAutoupdatePattern: setBoxAutoupdatePattern,

    getTimeZone: getTimeZone,
    setTimeZone: setTimeZone,

    getCloudronName: getCloudronName,
    setCloudronName: setCloudronName,

    getCloudronAvatar: getCloudronAvatar,
    setCloudronAvatar: setCloudronAvatar,

    getDynamicDnsConfig: getDynamicDnsConfig,
    setDynamicDnsConfig: setDynamicDnsConfig,

    getBackupConfig: getBackupConfig,
    setBackupConfig: setBackupConfig,

    getCaasConfig: getCaasConfig,

    getAppstoreConfig: getAppstoreConfig,
    setAppstoreConfig: setAppstoreConfig,

    getEmailDigest: getEmailDigest,
    setEmailDigest: setEmailDigest,

    getPlatformConfig: getPlatformConfig,
    setPlatformConfig: setPlatformConfig,

    get: get,
    getAll: getAll,

    // booleans. if you add an entry here, be sure to fix getAll
    DYNAMIC_DNS_KEY: 'dynamic_dns',
    EMAIL_DIGEST: 'email_digest',

    // json. if you add an entry here, be sure to fix getAll
    BACKUP_CONFIG_KEY: 'backup_config',
    APPSTORE_CONFIG_KEY: 'appstore_config',
    CAAS_CONFIG_KEY: 'caas_config',
    PLATFORM_CONFIG_KEY: 'platform_config',

    // strings
    APP_AUTOUPDATE_PATTERN_KEY: 'app_autoupdate_pattern',
    BOX_AUTOUPDATE_PATTERN_KEY: 'box_autoupdate_pattern',
    TIME_ZONE_KEY: 'time_zone',
    CLOUDRON_NAME_KEY: 'cloudron_name',

    // blobs
    CLOUDRON_AVATAR_KEY: 'cloudron_avatar', // not stored in db but can be used for locked flag

    on: on,
    removeListener: removeListener
};

var addons = require('./addons.js'),
    appstore = require('./appstore.js'),
    AppstoreError = require('./appstore.js').AppstoreError,
    assert = require('assert'),
    backups = require('./backups.js'),
    BackupsError = backups.BackupsError,
    constants = require('./constants.js'),
    CronJob = require('cron').CronJob,
    DatabaseError = require('./databaseerror.js'),
    moment = require('moment-timezone'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    settingsdb = require('./settingsdb.js'),
    util = require('util'),
    _ = require('underscore');

var gDefaults = (function () {
    var result = { };
    result[exports.APP_AUTOUPDATE_PATTERN_KEY] = '00 30 1,3,5,23 * * *';
    result[exports.BOX_AUTOUPDATE_PATTERN_KEY] = '00 00 1,3,5,23 * * *';
    result[exports.TIME_ZONE_KEY] = 'America/Los_Angeles';
    result[exports.CLOUDRON_NAME_KEY] = 'Cloudron';
    result[exports.DYNAMIC_DNS_KEY] = false;
    result[exports.BACKUP_CONFIG_KEY] = {
        provider: 'filesystem',
        key: '',
        backupFolder: '/var/backups',
        format: 'tgz',
        retentionSecs: 2 * 24 * 60 * 60, // 2 days
        intervalSecs: 24 * 60 * 60 // ~1 day
    };
    result[exports.APPSTORE_CONFIG_KEY] = {};
    result[exports.CAAS_CONFIG_KEY] = {};
    result[exports.EMAIL_DIGEST] = true;
    result[exports.PLATFORM_CONFIG_KEY] = {};

    return result;
})();

let gEvents = new (require('events').EventEmitter)();

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

function on(key, handler) {
    gEvents.on(key, handler);
}

function removeListener(key, handler) {
    gEvents.removeListener(key, handler);
}

function setAppAutoupdatePattern(pattern, callback) {
    assert.strictEqual(typeof pattern, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (pattern !== constants.AUTOUPDATE_PATTERN_NEVER) { // check if pattern is valid
        var job = safe.safeCall(function () { return new CronJob(pattern); });
        if (!job) return callback(new SettingsError(SettingsError.BAD_FIELD, 'Invalid pattern'));
    }

    settingsdb.set(exports.APP_AUTOUPDATE_PATTERN_KEY, pattern, function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        gEvents.emit(exports.APP_AUTOUPDATE_PATTERN_KEY, pattern);

        return callback(null);
    });
}

function getAppAutoupdatePattern(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.APP_AUTOUPDATE_PATTERN_KEY, function (error, pattern) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.APP_AUTOUPDATE_PATTERN_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, pattern);
    });
}

function setBoxAutoupdatePattern(pattern, callback) {
    assert.strictEqual(typeof pattern, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (pattern !== constants.AUTOUPDATE_PATTERN_NEVER) { // check if pattern is valid
        var job = safe.safeCall(function () { return new CronJob(pattern); });
        if (!job) return callback(new SettingsError(SettingsError.BAD_FIELD, 'Invalid pattern'));
    }

    settingsdb.set(exports.BOX_AUTOUPDATE_PATTERN_KEY, pattern, function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        gEvents.emit(exports.BOX_AUTOUPDATE_PATTERN_KEY, pattern);

        return callback(null);
    });
}

function getBoxAutoupdatePattern(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.BOX_AUTOUPDATE_PATTERN_KEY, function (error, pattern) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.BOX_AUTOUPDATE_PATTERN_KEY]);
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

        gEvents.emit(exports.TIME_ZONE_KEY, tz);

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

        gEvents.emit(exports.CLOUDRON_NAME_KEY, name);

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

function getDynamicDnsConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.DYNAMIC_DNS_KEY, function (error, enabled) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.DYNAMIC_DNS_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, !!enabled); // settingsdb holds string values only
    });
}

function setDynamicDnsConfig(enabled, callback) {
    assert.strictEqual(typeof enabled, 'boolean');
    assert.strictEqual(typeof callback, 'function');

    // settingsdb takes string values only
    settingsdb.set(exports.DYNAMIC_DNS_KEY, enabled ? 'enabled' : '', function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        gEvents.emit(exports.DYNAMIC_DNS_KEY, enabled);

        return callback(null);
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

    getBackupConfig(function (error, curentConfig) {
        if (error) return callback(error);

        backups.injectPrivateFields(backupConfig, curentConfig);

        backups.testConfig(backupConfig, function (error) {
            if (error && error.reason === BackupsError.BAD_FIELD) return callback(new SettingsError(SettingsError.BAD_FIELD, error.message));
            if (error && error.reason === BackupsError.EXTERNAL_ERROR) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, error.message));
            if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

            backups.cleanupCacheFilesSync();

            backupConfig = _.extend({}, curentConfig, backupConfig); // merge token/key/secret

            settingsdb.set(exports.BACKUP_CONFIG_KEY, JSON.stringify(backupConfig), function (error) {
                if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

                gEvents.emit(exports.BACKUP_CONFIG_KEY, backupConfig);

                callback(null);
            });
        });
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

        gEvents.emit(exports.EMAIL_DIGEST, enabled);

        callback(null);
    });
}

function getCaasConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.CAAS_CONFIG_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.CAAS_CONFIG_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value));
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

function getPlatformConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.PLATFORM_CONFIG_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.PLATFORM_CONFIG_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value));
    });
}

function setPlatformConfig(platformConfig, callback) {
    assert.strictEqual(typeof callback, 'function');

    for (let addon of [ 'mysql', 'postgresql', 'mail', 'mongodb' ]) {
        if (!platformConfig[addon]) continue;
        if (platformConfig[addon].memorySwap < platformConfig[addon].memory) return callback(new SettingsError(SettingsError.BAD_FIELD, 'memorySwap must be larger than memory'));
    }

    settingsdb.set(exports.PLATFORM_CONFIG_KEY, JSON.stringify(platformConfig), function (error) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        addons.updateServiceConfig(platformConfig, callback);
    });
}

function setAppstoreConfig(appstoreConfig, callback) {
    assert.strictEqual(typeof appstoreConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    appstore.registerCloudron(appstoreConfig, function (error, cloudronId) {
        if (error && error.reason === AppstoreError.EXTERNAL_ERROR) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, error.message));
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        let data = {
            userId: appstoreConfig.userId,
            token: appstoreConfig.token,
            cloudronId: cloudronId
        };

        settingsdb.set(exports.APPSTORE_CONFIG_KEY, JSON.stringify(data), function (error) {
            if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

            gEvents.emit(exports.APPSTORE_CONFIG_KEY, appstoreConfig);

            callback(null);
        });
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.getAll(function (error, settings) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        var result = _.extend({ }, gDefaults);
        settings.forEach(function (setting) { result[setting.name] = setting.value; });

        // convert booleans
        result[exports.DYNAMIC_DNS_KEY] = !!result[exports.DYNAMIC_DNS_KEY];

        // convert JSON objects
        [exports.BACKUP_CONFIG_KEY, exports.APPSTORE_CONFIG_KEY, exports.PLATFORM_CONFIG_KEY ].forEach(function (key) {
            result[key] = typeof result[key] === 'object' ? result[key] : safe.JSON.parse(result[key]);
        });

        callback(null, result);
    });
}

function get(name, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(name, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.PLATFORM_CONFIG_KEY]);
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        callback(null, result);
    });
}