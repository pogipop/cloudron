'use strict';

exports = module.exports = {
    purchase: purchase,
    unpurchase: unpurchase,

    sendAliveStatus: sendAliveStatus,

    AppstoreError: AppstoreError
};

var assert = require('assert'),
    config = require('./config.js'),
    debug = require('debug')('box:appstore'),
    os = require('os'),
    settings = require('./settings.js'),
    superagent = require('superagent'),
    util = require('util');

function AppstoreError(reason, errorOrMessage) {
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
util.inherits(AppstoreError, Error);
AppstoreError.INTERNAL_ERROR = 'Internal Error';
AppstoreError.EXTERNAL_ERROR = 'External Error';
AppstoreError.NOT_FOUND = 'Internal Error';
AppstoreError.BILLING_REQUIRED = 'Billing Required';

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

function getAppstoreConfig(callback) {
    // Caas Cloudrons do not store appstore credentials in their local database
    if (config.provider() === 'caas') {
        var url = config.apiServerOrigin() + '/api/v1/exchangeBoxTokenWithUserToken';
        superagent.post(url).query({ token: config.token() }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
            if (result.statusCode !== 201) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('App unpurchase failed. %s %j', result.status, result.body)));

            callback(null, result.body);
        });
    } else {
        settings.getAppstoreConfig(function (error, result) {
            if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));
            if (!result.token) return callback(new AppstoreError(AppstoreError.BILLING_REQUIRED));

            callback(null, result);
        });
    }
}

function purchase(appId, appstoreId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof appstoreId, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (appstoreId === '') return callback(null);

    getAppstoreConfig(function (error, appstoreConfig) {
        if (error) return callback(error);

        var url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + appstoreConfig.cloudronId + '/apps/' + appId;
        var data = { appstoreId: appstoreId };

        superagent.post(url).send(data).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
            if (result.statusCode === 404) return callback(new AppstoreError(AppstoreError.NOT_FOUND));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new AppstoreError(AppstoreError.BILLING_REQUIRED));
            if (result.statusCode !== 201 && result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('App purchase failed. %s %j', result.status, result.body)));

            callback(null);
        });
    });
}

function unpurchase(appId, appstoreId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof appstoreId, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (appstoreId === '') return callback(null);

    getAppstoreConfig(function (error, appstoreConfig) {
        if (error) return callback(error);

        var url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + appstoreConfig.cloudronId + '/apps/' + appId;

        superagent.get(url).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new AppstoreError(AppstoreError.BILLING_REQUIRED));
            if (result.statusCode === 404) return callback(null);   // was never purchased
            if (result.statusCode !== 201 && result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('App purchase failed. %s %j', result.status, result.body)));

            superagent.del(url).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
                if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
                if (result.statusCode === 403 || result.statusCode === 401) return callback(new AppstoreError(AppstoreError.BILLING_REQUIRED));
                if (result.statusCode !== 204) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('App unpurchase failed. %s %j', result.status, result.body)));

                callback(null);
            });
        });
    });
}

function sendAliveStatus(data, callback) {
    callback = callback || NOOP_CALLBACK;

    settings.getAll(function (error, result) {
        if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));

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
            },
            autoupdatePattern: result[settings.AUTOUPDATE_PATTERN_KEY],
            timeZone: result[settings.TIME_ZONE_KEY]
        };

        var data = {
            domain: config.fqdn(),
            version: config.version(),
            provider: config.provider(),
            backendSettings: backendSettings,
            machine: {
                cpus: os.cpus(),
                totalmem: os.totalmem()
            }
        };

        getAppstoreConfig(function (error, appstoreConfig) {
            if (error) return callback(error);

            var url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + appstoreConfig.cloudronId + '/alive';
            superagent.post(url).send(data).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
                if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
                if (result.statusCode === 404) return callback(new AppstoreError(AppstoreError.NOT_FOUND));
                if (result.statusCode !== 201) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Sending alive status failed. %s %j', result.status, result.body)));

                callback(null);
            });
        });
    });
}
