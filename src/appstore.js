'use strict';

exports = module.exports = {
    purchase: purchase,
    unpurchase: unpurchase,

    getSubscription: getSubscription,

    sendAliveStatus: sendAliveStatus,

    getAppUpdate: getAppUpdate,
    getBoxUpdate: getBoxUpdate,

    getAccount: getAccount,

    sendFeedback: sendFeedback,

    AppstoreError: AppstoreError
};

var assert = require('assert'),
    config = require('./config.js'),
    debug = require('debug')('box:appstore'),
    eventlog = require('./eventlog.js'),
    mail = require('./mail.js'),
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
    assert.strictEqual(typeof callback, 'function');

    settings.getAppstoreConfig(function (error, result) {
        if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));
        if (!result.token) return callback(new AppstoreError(AppstoreError.BILLING_REQUIRED));

        callback(null, result);
    });
}

function getSubscription(callback) {
    assert.strictEqual(typeof callback, 'function');

    getAppstoreConfig(function (error, appstoreConfig) {
        if (error) return callback(error);

        const url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + appstoreConfig.cloudronId + '/subscription';
        superagent.get(url).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
            if (result.statusCode === 401) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, 'invalid appstore token'));
            if (result.statusCode === 403) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, 'wrong user'));
            if (result.statusCode === 502) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, 'stripe error'));
            if (result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, 'unknown error'));

            callback(null, result.body.subscription);
        });
    });
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
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
            if (result.statusCode === 404) return callback(new AppstoreError(AppstoreError.NOT_FOUND));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new AppstoreError(AppstoreError.BILLING_REQUIRED));
            if (result.statusCode === 402) return callback(new AppstoreError(AppstoreError.BILLING_REQUIRED, result.body.message));
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

        mail.getAll(function (error, mailDomains) {
            if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));

            eventlog.getAllPaged(eventlog.ACTION_USER_LOGIN, null, 1, 1, function (error, loginEvents) {
                if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));

                var backendSettings = {
                    tlsConfig: {
                        provider: result[settings.TLS_CONFIG_KEY].provider
                    },
                    backupConfig: {
                        provider: result[settings.BACKUP_CONFIG_KEY].provider,
                        hardlinks: !result[settings.BACKUP_CONFIG_KEY].noHardlinks
                    },
                    domainConfig: {
                        count: mailDomains.length
                    },
                    mailConfig: {
                        outboundCount: mailDomains.length,
                        inboundCount: mailDomains.filter(function (d) { return d.enabled; }).length,
                        catchAllCount: mailDomains.filter(function (d) { return d.catchAll.length !== 0; }).length,
                        relayProviders: Array.from(new Set(mailDomains.map(function (d) { return d.relay.provider; })))
                    },
                    autoupdatePattern: result[settings.AUTOUPDATE_PATTERN_KEY],
                    timeZone: result[settings.TIME_ZONE_KEY],
                };

                var data = {
                    version: config.version(),
                    adminFqdn: config.adminFqdn(),
                    provider: config.provider(),
                    backendSettings: backendSettings,
                    machine: {
                        cpus: os.cpus(),
                        totalmem: os.totalmem()
                    },
                    events: {
                        lastLogin: loginEvents[0] ? (new Date(loginEvents[0].creationTime).getTime()) : 0
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
        });
    });
}

function getBoxUpdate(callback) {
    assert.strictEqual(typeof callback, 'function');

    getAppstoreConfig(function (error, appstoreConfig) {
        if (error) return callback(error);

        var url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + appstoreConfig.cloudronId + '/boxupdate';

        superagent.get(url).query({ accessToken: appstoreConfig.token, boxVersion: config.version() }).timeout(10 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
            if (result.statusCode === 204) return callback(null); // no update
            if (result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response: %s %s', result.statusCode, result.text)));

            // { version, changelog, upgrade, sourceTarballUrl}
            callback(null, result.body);
        });
    });
}

function getAppUpdate(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    getAppstoreConfig(function (error, appstoreConfig) {
        if (error) return callback(error);

        var url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + appstoreConfig.cloudronId + '/appupdate';

        superagent.get(url).query({ accessToken: appstoreConfig.token, boxVersion: config.version(), appId: app.appStoreId, appVersion: app.manifest.version }).timeout(10 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
            if (result.statusCode === 204) return callback(null); // no update
            if (result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response: %s %s', result.statusCode, result.text)));

            // { id, creationDate, manifest }
            callback(null, result.body);
        });
    });
}

function getAccount(callback) {
    assert.strictEqual(typeof callback, 'function');

    getAppstoreConfig(function (error, appstoreConfig) {
        if (error) return callback(error);

        var url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId;

        superagent.get(url).query({ accessToken: appstoreConfig.token }).timeout(10 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
            if (result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response: %s %s', result.statusCode, result.text)));

            // { profile: { id, email, groupId, billing, firstName, lastName, company, street, city, zip, state, country } }
            callback(null, result.body.profile);
        });
    });
}

function sendFeedback(info, callback) {
    assert.strictEqual(typeof info, 'object');
    assert.strictEqual(typeof info.email, 'string');
    assert.strictEqual(typeof info.displayName, 'string');
    assert.strictEqual(typeof info.type, 'string');
    assert.strictEqual(typeof info.subject, 'string');
    assert.strictEqual(typeof info.description, 'string');
    assert.strictEqual(typeof callback, 'function');

    getAppstoreConfig(function (error, appstoreConfig) {
        if (error) return callback(error);

        var url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + appstoreConfig.cloudronId + '/feedback';

        superagent.post(url).query({ accessToken: appstoreConfig.token }).send(info).timeout(10 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
            if (result.statusCode !== 201) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response: %s %s', result.statusCode, result.text)));

            callback(null);
        });
    });
}
