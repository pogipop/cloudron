'use strict';

exports = module.exports = {
    set: set,
    get: get,

    // specialized routes as they need different scope or some additional middleware
    getCloudronAvatar: getCloudronAvatar,
    setCloudronAvatar: setCloudronAvatar,

    getAppstoreConfig: getAppstoreConfig,
    setAppstoreConfig: setAppstoreConfig
};

var assert = require('assert'),
    backups = require('../backups.js'),
    docker = require('../docker.js'),
    DockerError = docker.DockerError,
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    safe = require('safetydance'),
    settings = require('../settings.js'),
    SettingsError = settings.SettingsError;

function getAppAutoupdatePattern(req, res, next) {
    settings.getAppAutoupdatePattern(function (error, pattern) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { pattern: pattern }));
    });
}

function setAppAutoupdatePattern(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.pattern !== 'string') return next(new HttpError(400, 'pattern is required'));

    settings.setAppAutoupdatePattern(req.body.pattern, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, {}));
    });
}

function getBoxAutoupdatePattern(req, res, next) {
    settings.getBoxAutoupdatePattern(function (error, pattern) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { pattern: pattern }));
    });
}

function setBoxAutoupdatePattern(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.pattern !== 'string') return next(new HttpError(400, 'pattern is required'));

    settings.setBoxAutoupdatePattern(req.body.pattern, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, {}));
    });
}

function setCloudronName(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.name !== 'string') return next(new HttpError(400, 'name is required'));

    settings.setCloudronName(req.body.name, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}

function getCloudronName(req, res, next) {
    settings.getCloudronName(function (error, name) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { name: name }));
    });
}

function getTimeZone(req, res, next) {
    settings.getTimeZone(function (error, tz) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { timeZone: tz }));
    });
}

function setTimeZone(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.timeZone !== 'string') return next(new HttpError(400, 'timeZone is required'));

    settings.setTimeZone(req.body.timeZone, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, {}));
    });
}

function setCloudronAvatar(req, res, next) {
    assert.strictEqual(typeof req.files, 'object');

    if (!req.files.avatar) return next(new HttpError(400, 'avatar must be provided'));
    var avatar = safe.fs.readFileSync(req.files.avatar.path);

    settings.setCloudronAvatar(avatar, function (error) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}

function getCloudronAvatar(req, res, next) {
    settings.getCloudronAvatar(function (error, avatar) {
        if (error) return next(new HttpError(500, error));

        // avoid caching the avatar on the client to see avatar changes immediately
        res.set('Cache-Control', 'no-cache');

        res.set('Content-Type', 'image/png');
        res.status(200).send(avatar);
    });
}

function getBackupConfig(req, res, next) {
    settings.getBackupConfig(function (error, config) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, backups.removePrivateFields(config)));
    });
}

function setBackupConfig(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.provider !== 'string') return next(new HttpError(400, 'provider is required'));
    if (typeof req.body.retentionSecs !== 'number') return next(new HttpError(400, 'retentionSecs is required'));
    if (typeof req.body.intervalSecs !== 'number') return next(new HttpError(400, 'intervalSecs is required'));
    if ('key' in req.body && typeof req.body.key !== 'string') return next(new HttpError(400, 'key must be a string'));
    if ('syncConcurrency' in req.body) {
        if (typeof req.body.syncConcurrency !== 'number') return next(new HttpError(400, 'syncConcurrency must be a positive integer'));
        if (req.body.syncConcurrency < 1) return next(new HttpError(400, 'syncConcurrency must be a positive integer'));
    }
    if (typeof req.body.format !== 'string') return next(new HttpError(400, 'format must be a string'));
    if ('acceptSelfSignedCerts' in req.body && typeof req.body.acceptSelfSignedCerts !== 'boolean') return next(new HttpError(400, 'format must be a boolean'));

    // testing the backup using put/del takes a bit of time at times
    req.clearTimeout();

    settings.setBackupConfig(req.body, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === SettingsError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, {}));
    });
}

function getPlatformConfig(req, res, next) {
    settings.getPlatformConfig(function (error, config) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, config));
    });
}

function setPlatformConfig(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    for (let addon of [ 'mysql', 'postgresql', 'mail', 'mongodb' ]) {
        if (!(addon in req.body)) continue;
        if (typeof req.body[addon] !== 'object') return next(new HttpError(400, 'addon config must be an object'));

        if (typeof req.body[addon].memory !== 'number') return next(new HttpError(400, 'memory must be a number'));
        if (typeof req.body[addon].memorySwap !== 'number') return next(new HttpError(400, 'memorySwap must be a number'));
    }

    settings.setPlatformConfig(req.body, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === SettingsError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, {}));
    });
}

function getDynamicDnsConfig(req, res, next) {
    settings.getDynamicDnsConfig(function (error, enabled) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { enabled: enabled }));
    });
}

function setDynamicDnsConfig(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.enabled !== 'boolean') return next(new HttpError(400, 'enabled boolean is required'));

    settings.setDynamicDnsConfig(req.body.enabled, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, {}));
    });
}


function getAppstoreConfig(req, res, next) {
    settings.getAppstoreConfig(function (error, result) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, result));
    });
}

function setAppstoreConfig(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.userId !== 'string') return next(new HttpError(400, 'userId is required'));
    if (typeof req.body.token !== 'string') return next(new HttpError(400, 'token is required'));

    var options = {
        userId: req.body.userId,
        token: req.body.token
    };

    settings.setAppstoreConfig(options, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === SettingsError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        settings.getAppstoreConfig(function (error, result) {
            if (error) return next(new HttpError(500, error));

            next(new HttpSuccess(202, result));
        });
    });
}

function setRegistryConfig(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.serveraddress !== 'string') return next(new HttpError(400, 'serveraddress is required'));
    if ('username' in req.body && typeof req.body.username !== 'string') return next(new HttpError(400, 'username is required'));
    if ('password' in req.body && typeof req.body.password !== 'string') return next(new HttpError(400, 'password is required'));

    docker.setRegistryConfig(req.body, function (error) {
        if (error && error.reason === DockerError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200));
    });
}

function get(req, res, next) {
    assert.strictEqual(typeof req.params.setting, 'string');

    switch (req.params.setting) {
    case settings.DYNAMIC_DNS_KEY: return getDynamicDnsConfig(req, res, next);
    case settings.BACKUP_CONFIG_KEY: return getBackupConfig(req, res, next);
    case settings.PLATFORM_CONFIG_KEY: return getPlatformConfig(req, res, next);

    case settings.APP_AUTOUPDATE_PATTERN_KEY: return getAppAutoupdatePattern(req, res, next);
    case settings.BOX_AUTOUPDATE_PATTERN_KEY: return getBoxAutoupdatePattern(req, res, next);
    case settings.TIME_ZONE_KEY: return getTimeZone(req, res, next);
    case settings.CLOUDRON_NAME_KEY: return getCloudronName(req, res, next);

    case settings.CLOUDRON_AVATAR_KEY: return getCloudronAvatar(req, res, next);

    default: return next(new HttpError(404, 'No such setting'));
    }
}

function set(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    switch (req.params.setting) {
    case settings.DYNAMIC_DNS_KEY: return setDynamicDnsConfig(req, res, next);
    case settings.BACKUP_CONFIG_KEY: return setBackupConfig(req, res, next);
    case settings.PLATFORM_CONFIG_KEY: return setPlatformConfig(req, res, next);

    case settings.APP_AUTOUPDATE_PATTERN_KEY: return setAppAutoupdatePattern(req, res, next);
    case settings.BOX_AUTOUPDATE_PATTERN_KEY: return setBoxAutoupdatePattern(req, res, next);
    case settings.TIME_ZONE_KEY: return setTimeZone(req, res, next);
    case settings.CLOUDRON_NAME_KEY: return setCloudronName(req, res, next);

    default: return next(new HttpError(404, 'No such setting'));
    }
}
