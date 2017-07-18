'use strict';

exports = module.exports = {
    getAutoupdatePattern: getAutoupdatePattern,
    setAutoupdatePattern: setAutoupdatePattern,

    getCloudronName: getCloudronName,
    setCloudronName: setCloudronName,

    getCloudronAvatar: getCloudronAvatar,
    setCloudronAvatar: setCloudronAvatar,

    getEmailStatus: getEmailStatus,

    getDnsConfig: getDnsConfig,
    setDnsConfig: setDnsConfig,

    getBackupConfig: getBackupConfig,
    setBackupConfig: setBackupConfig,

    getTimeZone: getTimeZone,
    setTimeZone: setTimeZone,

    getMailConfig: getMailConfig,
    setMailConfig: setMailConfig,

    getMailRelay: getMailRelay,
    setMailRelay: setMailRelay,

    getCatchAllAddress: getCatchAllAddress,
    setCatchAllAddress: setCatchAllAddress,

    getMailFromValidation: getMailFromValidation,
    setMailFromValidation: setMailFromValidation,

    getAppstoreConfig: getAppstoreConfig,
    setAppstoreConfig: setAppstoreConfig,

    setFallbackCertificate: setFallbackCertificate,
    setAdminCertificate: setAdminCertificate
};

var assert = require('assert'),
    certificates = require('../certificates.js'),
    CertificatesError = require('../certificates.js').CertificatesError,
    config = require('../config.js'),
    email = require('../email.js'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    safe = require('safetydance'),
    settings = require('../settings.js'),
    SettingsError = settings.SettingsError;

function getAutoupdatePattern(req, res, next) {
    settings.getAutoupdatePattern(function (error, pattern) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { pattern: pattern }));
    });
}

function setAutoupdatePattern(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.pattern !== 'string') return next(new HttpError(400, 'pattern is required'));

    settings.setAutoupdatePattern(req.body.pattern, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200));
    });
}

function setCloudronName(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.name !== 'string') return next(new HttpError(400, 'name is required'));

    settings.setCloudronName(req.body.name, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
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

        next(new HttpSuccess(200));
    });
}

function getMailConfig(req, res, next) {
    settings.getMailConfig(function (error, mail) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, mail));
    });
}

function setMailConfig(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.enabled !== 'boolean') return next(new HttpError(400, 'enabled is required'));

    settings.setMailConfig({ enabled: req.body.enabled }, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function getMailFromValidation(req, res, next) {
    settings.getMailFromValidation(function (error, enabled) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { enabled: enabled }));
    });
}

function setMailFromValidation(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.enabled !== 'boolean') return next(new HttpError(400, 'enabled is required'));

    settings.setMailFromValidation({ enabled: req.body.enabled }, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function getMailRelay(req, res, next) {
    settings.getMailRelay(function (error, mail) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, mail));
    });
}

function setMailRelay(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.provider !== 'string') return next(new HttpError(400, 'provider is required'));
    if ('host' in req.body && typeof req.body.host !== 'string') return next(new HttpError(400, 'host must be a string'));
    if ('port' in req.body && typeof req.body.port !== 'number') return next(new HttpError(400, 'port must be a string'));
    if ('username' in req.body && typeof req.body.username !== 'string') return next(new HttpError(400, 'username must be a string'));
    if ('password' in req.body && typeof req.body.password !== 'string') return next(new HttpError(400, 'password must be a string'));

    settings.setMailRelay(req.body, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function getCatchAllAddress(req, res, next) {
    settings.getCatchAllAddress(function (error, address) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { address: address }));
    });
}

function setCatchAllAddress(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.address || !Array.isArray(req.body.address)) return next(new HttpError(400, 'address array is required'));

    for (var i = 0; i < req.body.address.length; i++) {
        if (typeof req.body.address[i] !== 'string') return next(new HttpError(400, 'address must be an array of string'));
    }

    settings.setCatchAllAddress(req.body.address, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
    });
}

function setCloudronAvatar(req, res, next) {
    assert.strictEqual(typeof req.files, 'object');

    if (!req.files.avatar) return next(new HttpError(400, 'avatar must be provided'));
    var avatar = safe.fs.readFileSync(req.files.avatar.path);

    settings.setCloudronAvatar(avatar, function (error) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202));
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

function getEmailStatus(req, res, next) {
    email.getStatus(function (error, records) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, records));
    });
}

function getDnsConfig(req, res, next) {
    settings.getDnsConfig(function (error, config) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, config));
    });
}

function setDnsConfig(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.provider !== 'string') return next(new HttpError(400, 'provider is required'));

    settings.setDnsConfig(req.body, config.fqdn(), config.zoneName(), function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200));
    });
}

function getBackupConfig(req, res, next) {
    settings.getBackupConfig(function (error, config) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, config));
    });
}

function setBackupConfig(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.provider !== 'string') return next(new HttpError(400, 'provider is required'));
    if (typeof req.body.retentionSecs !== 'number') return next(new HttpError(400, 'retentionSecs is required'));
    if ('key' in req.body && typeof req.body.key !== 'string') return next(new HttpError(400, 'key must be a string'));

    settings.setBackupConfig(req.body, function (error) {
        if (error && error.reason === SettingsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === SettingsError.EXTERNAL_ERROR) return next(new HttpError(402, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200));
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
        if (error && error.reason === SettingsError.EXTERNAL_ERROR) return next(new HttpError(406, error.message));
        if (error) return next(new HttpError(500, error));

        settings.getAppstoreConfig(function (error, result) {
            if (error) return next(new HttpError(500, error));

            next(new HttpSuccess(202, result));
        });
    });
}

// default fallback cert
function setFallbackCertificate(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.cert || typeof req.body.cert !== 'string') return next(new HttpError(400, 'cert must be a string'));
    if (!req.body.key || typeof req.body.key !== 'string') return next(new HttpError(400, 'key must be a string'));

    certificates.setFallbackCertificate(req.body.cert, req.body.key, function (error) {
        if (error && error.reason === CertificatesError.INVALID_CERT) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}

// only webadmin cert, until it can be treated just like a normal app
function setAdminCertificate(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.cert || typeof req.body.cert !== 'string') return next(new HttpError(400, 'cert must be a string'));
    if (!req.body.key || typeof req.body.key !== 'string') return next(new HttpError(400, 'key must be a string'));

    certificates.setAdminCertificate(req.body.cert, req.body.key, function (error) {
        if (error && error.reason === CertificatesError.INVALID_CERT) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}
