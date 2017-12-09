'use strict';

exports = module.exports = {
    migrate: migrate,
    changePlan: changePlan,
    upgrade: upgrade
};

var assert = require('assert'),
    backups = require('./backups.js'),
    config = require('./config.js'),
    debug = require('debug')('box:caas'),
    domains = require('./domains.js'),
    DomainError = domains.DomainError,
    locker = require('./locker.js'),
    path = require('path'),
    progress = require('./progress.js'),
    settings = require('./settings.js'),
    SettingsError = settings.SettingsError,
    shell = require('./shell.js'),
    superagent = require('superagent'),
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
CaasError.INTERNAL_ERROR = 'Internal Error';
CaasError.EXTERNAL_ERROR = 'External Error';
CaasError.BAD_STATE = 'Bad state';

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

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
    if (error) return callback(new CaasError(CaasError.BAD_STATE, error.message));

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
                if (result.statusCode === 409) return unlock(new CaasError(CaasError.BAD_STATE));
                if (result.statusCode === 404) return unlock(new CaasError(CaasError.NOT_FOUND));
                if (result.statusCode !== 202) return unlock(new CaasError(CaasError.EXTERNAL_ERROR, util.format('%s %j', result.status, result.body)));

                progress.set(progress.MIGRATE, 10, 'Migrating');

                retire('migrate', _.pick(options, 'domain', 'size', 'region'));
            });
    });

    callback(null);
}

function changePlan(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (config.isDemo()) return callback(new CaasError(CaasError.BAD_FIELD, 'Not allowed in demo mode'));

    doMigrate(options, callback);
}

function migrate(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (config.isDemo()) return callback(new CaasError(CaasError.BAD_FIELD, 'Not allowed in demo mode'));

    if (!options.domain) return doMigrate(options, callback);

    var dnsConfig = _.pick(options, 'domain', 'provider', 'accessKeyId', 'secretAccessKey', 'region', 'endpoint', 'token', 'zoneName');

    domains.get(options.domain, function (error, result) {
        if (error && error.reason !== DomainError.NOT_FOUND) return callback(new CaasError(CaasError.INTERNAL_ERROR, error));

        var func;
        if (!result) func = domains.add.bind(null, options.domain, options.zoneName, dnsConfig, null);
        else func = domains.update.bind(null, options.domain, dnsConfig, null);

        func(function (error) {
            if (error && error.reason === DomainError.BAD_FIELD) return callback(new CaasError(CaasError.BAD_FIELD, error.message));
            if (error) return callback(new SettingsError(CaasError.INTERNAL_ERROR, error));

            // TODO: should probably rollback dns config if migrate fails
            doMigrate(options, callback);
        });
    });
}

// this function expects a lock
function upgrade(boxUpdateInfo, callback) {
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

