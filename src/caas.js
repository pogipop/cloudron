'use strict';

exports = module.exports = {
    verifySetupToken: verifySetupToken,
    setupDone: setupDone,

    backupDone: backupDone,

    sendHeartbeat: sendHeartbeat,
    setPtrRecord: setPtrRecord,

    CaasError: CaasError
};

var assert = require('assert'),
    config = require('./config.js'),
    debug = require('debug')('box:caas'),
    settings = require('./settings.js'),
    superagent = require('superagent'),
    util = require('util');

function CaasError(reason, errorOrMessage) {
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
util.inherits(CaasError, Error);
CaasError.BAD_FIELD = 'Field error';
CaasError.BAD_STATE = 'Bad state';
CaasError.INVALID_TOKEN = 'Invalid Token';
CaasError.INTERNAL_ERROR = 'Internal Error';
CaasError.EXTERNAL_ERROR = 'External Error';

function getCaasConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settings.getCaasConfig(function (error, result) {
        if (error) return callback(new CaasError(CaasError.INTERNAL_ERROR, error));

        callback(null, result);
    });
}

function verifySetupToken(setupToken, callback) {
    assert.strictEqual(typeof setupToken, 'string');
    assert.strictEqual(typeof callback, 'function');

    settings.getCaasConfig(function (error, caasConfig) {
        if (error) return callback(new CaasError(CaasError.INTERNAL_ERROR, error));

        superagent.get(config.apiServerOrigin() + '/api/v1/caas/boxes/' + caasConfig.boxId + '/setup/verify').query({ setupToken: setupToken })
            .timeout(30 * 1000)
            .end(function (error, result) {
                if (error && !error.response) return callback(new CaasError(CaasError.EXTERNAL_ERROR, error));
                if (result.statusCode === 403) return callback(new CaasError(CaasError.INVALID_TOKEN));
                if (result.statusCode === 409) return callback(new CaasError(CaasError.BAD_STATE, 'Already setup'));
                if (result.statusCode !== 200) return callback(new CaasError(CaasError.EXTERNAL_ERROR, error));

                callback(null);
            });
    });
}

function setupDone(setupToken, callback) {
    assert.strictEqual(typeof setupToken, 'string');
    assert.strictEqual(typeof callback, 'function');

    settings.getCaasConfig(function (error, caasConfig) {
        if (error) return callback(new CaasError(CaasError.INTERNAL_ERROR, error));

        // Now let the api server know we got activated
        superagent.post(config.apiServerOrigin() + '/api/v1/caas/boxes/' + caasConfig.boxId + '/setup/done').query({ setupToken: setupToken })
            .timeout(30 * 1000)
            .end(function (error, result) {
                if (error && !error.response) return callback(new CaasError(CaasError.EXTERNAL_ERROR, error));
                if (result.statusCode === 403) return callback(new CaasError(CaasError.INVALID_TOKEN));
                if (result.statusCode === 409) return callback(new CaasError(CaasError.BAD_STATE, 'Already setup'));
                if (result.statusCode !== 201) return callback(new CaasError(CaasError.EXTERNAL_ERROR, error));

                callback(null);
            });
    });
}

function backupDone(apiConfig, backupId, appBackupIds, callback) {
    assert.strictEqual(typeof apiConfig, 'object');
    assert.strictEqual(typeof backupId, 'string');
    assert(Array.isArray(appBackupIds));
    assert.strictEqual(typeof callback, 'function');

    if (apiConfig.provider !== 'caas') return callback();

    debug('[%s] backupDone: %s apps %j', backupId, backupId, appBackupIds);

    var url = config.apiServerOrigin() + '/api/v1/caas/boxes/' + apiConfig.fqdn + '/backupDone';
    var data = {
        boxVersion: config.version(),
        backupId: backupId,
        appId: null,        // now unused
        appVersion: null,   // now unused
        appBackupIds: appBackupIds
    };

    superagent.post(url).send(data).query({ token: apiConfig.token }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(new CaasError(CaasError.EXTERNAL_ERROR, error));
        if (result.statusCode !== 200) return callback(new CaasError(CaasError.EXTERNAL_ERROR, result.text));

        return callback(null);
    });
}

function sendHeartbeat() {
    assert(config.provider() === 'caas', 'Heartbeat is only sent for managed cloudrons');

    getCaasConfig(function (error, result) {
        if (error) return debug('Caas config missing', error);

        var url = config.apiServerOrigin() + '/api/v1/caas/boxes/' + result.boxId + '/heartbeat';
        superagent.post(url).query({ token: result.token, version: config.version() }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) debug('Network error sending heartbeat.', error);
            else if (result.statusCode !== 200) debug('Server responded to heartbeat with %s %s', result.statusCode, result.text);
            else debug('Heartbeat sent to %s', url);
        });
    });
}

function setPtrRecord(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    getCaasConfig(function (error, result) {
        if (error) return callback(error);

        superagent
            .post(config.apiServerOrigin() + '/api/v1/caas/boxes/' + result.boxId + '/ptr')
            .query({ token: result.token })
            .send({ domain: domain })
            .timeout(5 * 1000)
            .end(function (error, result) {
                if (error && !error.response) return callback(new CaasError(CaasError.EXTERNAL_ERROR, 'Cannot reach appstore'));
                if (result.statusCode !== 202) return callback(new CaasError(CaasError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

                return callback(null);
            });
    });
}
