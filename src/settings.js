'use strict';

exports = module.exports = {
    SettingsError: SettingsError,

    initialize: initialize,
    uninitialize: uninitialize,

    getAutoupdatePattern: getAutoupdatePattern,
    setAutoupdatePattern: setAutoupdatePattern,

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

    getAll: getAll,

    // booleans. if you add an entry here, be sure to fix getAll
    DYNAMIC_DNS_KEY: 'dynamic_dns',
    EMAIL_DIGEST: 'email_digest',

    // json. if you add an entry here, be sure to fix getAll
    BACKUP_CONFIG_KEY: 'backup_config',
    UPDATE_CONFIG_KEY: 'update_config',
    APPSTORE_CONFIG_KEY: 'appstore_config',
    CAAS_CONFIG_KEY: 'caas_config',

    // strings
    AUTOUPDATE_PATTERN_KEY: 'autoupdate_pattern',
    TIME_ZONE_KEY: 'time_zone',
    CLOUDRON_NAME_KEY: 'cloudron_name',

    events: null
};

var assert = require('assert'),
    backups = require('./backups.js'),
    BackupsError = backups.BackupsError,
    config = require('./config.js'),
    constants = require('./constants.js'),
    CronJob = require('cron').CronJob,
    DatabaseError = require('./databaseerror.js'),
    moment = require('moment-timezone'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    settingsdb = require('./settingsdb.js'),
    superagent = require('superagent'),
    util = require('util'),
    _ = require('underscore');

var gDefaults = (function () {
    var result = { };
    result[exports.AUTOUPDATE_PATTERN_KEY] = '00 00 1,3,5,23 * * *';
    result[exports.TIME_ZONE_KEY] = 'America/Los_Angeles';
    result[exports.CLOUDRON_NAME_KEY] = 'Cloudron';
    result[exports.DYNAMIC_DNS_KEY] = false;
    result[exports.BACKUP_CONFIG_KEY] = {
        provider: 'filesystem',
        key: '',
        backupFolder: '/var/backups',
        retentionSecs: 172800
    };
    result[exports.UPDATE_CONFIG_KEY] = { prerelease: false };
    result[exports.APPSTORE_CONFIG_KEY] = {};
    result[exports.EMAIL_DIGEST] = true;

    return result;
})();

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

        exports.events.emit(exports.DYNAMIC_DNS_KEY, enabled);

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

    if (backupConfig.key && backupConfig.format !== 'tgz') return callback(new SettingsError(SettingsError.BAD_FIELD, 'format does not support encryption'));

    backups.testConfig(backupConfig, function (error) {
        if (error && error.reason === BackupsError.BAD_FIELD) return callback(new SettingsError(SettingsError.BAD_FIELD, error.message));
        if (error && error.reason === BackupsError.EXTERNAL_ERROR) return callback(new SettingsError(SettingsError.EXTERNAL_ERROR, error.message));
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        backups.cleanupCacheFilesSync();

        settingsdb.set(exports.BACKUP_CONFIG_KEY, JSON.stringify(backupConfig), function (error) {
            if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

            exports.events.emit(exports.BACKUP_CONFIG_KEY, backupConfig);

            callback(null);
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

        exports.events.emit(exports.EMAIL_DIGEST, enabled);

        callback(null);
    });
}

function getCaasConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.CAAS_CONFIG_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.APPSTORE_CONFIG_KEY]);
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
                domain: config.adminDomain()
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

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.getAll(function (error, settings) {
        if (error) return callback(new SettingsError(SettingsError.INTERNAL_ERROR, error));

        var result = _.extend({ }, gDefaults);
        settings.forEach(function (setting) { result[setting.name] = setting.value; });

        // convert booleans
        result[exports.DYNAMIC_DNS_KEY] = !!result[exports.DYNAMIC_DNS_KEY];

        // convert JSON objects
        [exports.BACKUP_CONFIG_KEY, exports.UPDATE_CONFIG_KEY, exports.APPSTORE_CONFIG_KEY ].forEach(function (key) {
            result[key] = typeof result[key] === 'object' ? result[key] : safe.JSON.parse(result[key]);
        });

        callback(null, result);
    });
}
