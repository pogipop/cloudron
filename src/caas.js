'use strict';

exports = module.exports = {
    verifySetupToken: verifySetupToken,
    setupDone: setupDone,

    changePlan: changePlan,
    sendHeartbeat: sendHeartbeat,
    getBoxAndUserDetails: getBoxAndUserDetails,
    setPtrRecord: setPtrRecord,

    CaasError: CaasError
};

var assert = require('assert'),
    backups = require('./backups.js'),
    config = require('./config.js'),
    debug = require('debug')('box:caas'),
    locker = require('./locker.js'),
    path = require('path'),
    settings = require('./settings.js'),
    shell = require('./shell.js'),
    superagent = require('superagent'),
    tasks = require('./tasks.js'),
    util = require('util'),
    _ = require('underscore');

const RETIRE_CMD = path.join(__dirname, 'scripts/retire.sh');

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

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

function retire(reason, info, callback) {
    assert(reason === 'migrate');
    info = info || { };
    callback = callback || NOOP_CALLBACK;

    var data = {
        apiServerOrigin: config.apiServerOrigin(),
        adminFqdn: config.adminFqdn()
    };
    shell.sudo('retire', [ RETIRE_CMD, reason, JSON.stringify(info), JSON.stringify(data) ], callback);
}

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

        superagent.get(config.apiServerOrigin() + '/api/v1/boxes/' + caasConfig.boxId + '/setup/verify').query({ setupToken: setupToken })
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
        superagent.post(config.apiServerOrigin() + '/api/v1/boxes/' + caasConfig.boxId + '/setup/done').query({ setupToken: setupToken })
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
function doMigrate(options, caasConfig, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof caasConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    var error = locker.lock(locker.OP_MIGRATE);
    if (error) return callback(new CaasError(CaasError.BAD_STATE, error.message));

    function unlock(error) {
        debug('Failed to migrate', error);
        locker.unlock(locker.OP_MIGRATE);
        tasks.setProgress(tasks.TASK_MIGRATE, { percent: -1, result: `Backup failed: ${error.message}` }, NOOP_CALLBACK);
    }

    tasks.setProgress(tasks.TASK_MIGRATE, { percent: 10, result: 'Backing up for migration' }, NOOP_CALLBACK);

    // initiate the migration in the background
    backups.backupBoxAndApps({ userId: null, username: 'migrator' }, function (error) {
        if (error) return unlock(error);

        debug('migrate: domain: %s size %s region %s', options.domain, options.size, options.region);

        superagent
            .post(config.apiServerOrigin() + '/api/v1/boxes/' + caasConfig.boxId + '/migrate')
            .query({ token: caasConfig.token })
            .send(options)
            .timeout(30 * 1000)
            .end(function (error, result) {
                if (error && !error.response) return unlock(error); // network error
                if (result.statusCode === 409) return unlock(new CaasError(CaasError.BAD_STATE));
                if (result.statusCode === 404) return unlock(new CaasError(CaasError.NOT_FOUND));
                if (result.statusCode !== 202) return unlock(new CaasError(CaasError.EXTERNAL_ERROR, util.format('%s %j', result.status, result.body)));

                tasks.setProgress(tasks.TASK_MIGRATE, { percent: 40, result: 'Migrating' }, NOOP_CALLBACK);

                retire('migrate', _.pick(options, 'domain', 'size', 'region'));
            });
    });

    callback(null);
}

function changePlan(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (config.isDemo()) return callback(new CaasError(CaasError.BAD_FIELD, 'Not allowed in demo mode'));

    getCaasConfig(function (error, result) {
        if (error) return callback(error);

        doMigrate(options, result, callback);
    });
}

function sendHeartbeat() {
    assert(config.provider() === 'caas', 'Heartbeat is only sent for managed cloudrons');

    getCaasConfig(function (error, result) {
        if (error) return debug('Caas config missing', error);

        var url = config.apiServerOrigin() + '/api/v1/boxes/' + result.boxId + '/heartbeat';
        superagent.post(url).query({ token: result.token, version: config.version() }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) debug('Network error sending heartbeat.', error);
            else if (result.statusCode !== 200) debug('Server responded to heartbeat with %s %s', result.statusCode, result.text);
            else debug('Heartbeat sent to %s', url);
        });
    });
}

function getBoxAndUserDetails(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (config.provider() !== 'caas') return callback(null, {});

    getCaasConfig(function (error, caasConfig) {
        if (error) return callback(error);

        superagent
            .get(config.apiServerOrigin() + '/api/v1/boxes/' + caasConfig.boxId)
            .query({ token: caasConfig.token })
            .timeout(30 * 1000)
            .end(function (error, result) {
                if (error && !error.response) return callback(new CaasError(CaasError.EXTERNAL_ERROR, 'Cannot reach appstore'));
                if (result.statusCode !== 200) return callback(new CaasError(CaasError.EXTERNAL_ERROR, util.format('%s %j', result.statusCode, result.body)));

                return callback(null, result.body);
            });
    });
}

function setPtrRecord(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    getCaasConfig(function (error, result) {
        if (error) return callback(error);

        superagent
            .post(config.apiServerOrigin() + '/api/v1/boxes/' + result.boxId + '/ptr')
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
