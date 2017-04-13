'use strict';

exports = module.exports = {
    purchase: purchase,
    unpurchase: unpurchase,

    sendAliveStatus: sendAliveStatus
};

var AppsError = require('./apps.js').AppsError,
    assert = require('assert'),
    CloudronError = require('./cloudron.js').CloudronError,
    config = require('./config.js'),
    debug = require('debug')('box:appstore'),
    settings = require('./settings.js'),
    superagent = require('superagent'),
    util = require('util');

function purchase(appId, appstoreId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof appstoreId, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (appstoreId === '') return callback(null);

    function purchaseWithAppstoreConfig(appstoreConfig) {
        assert.strictEqual(typeof appstoreConfig.userId, 'string');
        assert.strictEqual(typeof appstoreConfig.cloudronId, 'string');
        assert.strictEqual(typeof appstoreConfig.token, 'string');

        var url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + appstoreConfig.cloudronId + '/apps/' + appId;
        var data = { appstoreId: appstoreId };

        superagent.post(url).send(data).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error));
            if (result.statusCode === 404) return callback(new AppsError(AppsError.NOT_FOUND));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new AppsError(AppsError.BILLING_REQUIRED));
            if (result.statusCode !== 201 && result.statusCode !== 200) return callback(new AppsError(AppsError.EXTERNAL_ERROR, util.format('App purchase failed. %s %j', result.status, result.body)));

            callback(null);
        });
    }

    // Caas Cloudrons do not store appstore credentials in their local database
    if (config.provider() === 'caas') {
        var url = config.apiServerOrigin() + '/api/v1/exchangeBoxTokenWithUserToken';
        superagent.post(url).query({ token: config.token() }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error));
            if (result.statusCode !== 201) return callback(new AppsError(AppsError.EXTERNAL_ERROR, util.format('App purchase failed. %s %j', result.status, result.body)));

            purchaseWithAppstoreConfig(result.body);
        });
    } else {
        settings.getAppstoreConfig(function (error, result) {
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));
            if (!result.token) return callback(new AppsError(AppsError.BILLING_REQUIRED));

            purchaseWithAppstoreConfig(result);
        });
    }
}

function unpurchase(appId, appstoreId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof appstoreId, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (appstoreId === '') return callback(null);

    function unpurchaseWithAppstoreConfig(appstoreConfig) {
        assert.strictEqual(typeof appstoreConfig.userId, 'string');
        assert.strictEqual(typeof appstoreConfig.cloudronId, 'string');
        assert.strictEqual(typeof appstoreConfig.token, 'string');

        var url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + appstoreConfig.cloudronId + '/apps/' + appId;

        superagent.get(url).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new AppsError(AppsError.BILLING_REQUIRED));
            if (result.statusCode === 404) return callback(null);   // was never purchased
            if (result.statusCode !== 201 && result.statusCode !== 200) return callback(new AppsError(AppsError.EXTERNAL_ERROR, util.format('App purchase failed. %s %j', result.status, result.body)));

            superagent.del(url).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
                if (error && !error.response) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error));
                if (result.statusCode === 403 || result.statusCode === 401) return callback(new AppsError(AppsError.BILLING_REQUIRED));
                if (result.statusCode !== 204) return callback(new AppsError(AppsError.EXTERNAL_ERROR, util.format('App unpurchase failed. %s %j', result.status, result.body)));

                callback(null);
            });
        });
    }

    // Caas Cloudrons do not store appstore credentials in their local database
    if (config.provider() === 'caas') {
        var url = config.apiServerOrigin() + '/api/v1/exchangeBoxTokenWithUserToken';
        superagent.post(url).query({ token: config.token() }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error));
            if (result.statusCode !== 201) return callback(new AppsError(AppsError.EXTERNAL_ERROR, util.format('App unpurchase failed. %s %j', result.status, result.body)));

            unpurchaseWithAppstoreConfig(result.body);
        });
    } else {
        settings.getAppstoreConfig(function (error, result) {
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));
            if (!result.token) return callback(new AppsError(AppsError.BILLING_REQUIRED));

            unpurchaseWithAppstoreConfig(result);
        });
    }
}

function sendAliveStatus(data, callback) {

    function sendAliveStatusWithAppstoreConfig(data, appstoreConfig) {
        assert.strictEqual(typeof data, 'object');
        assert.strictEqual(typeof appstoreConfig.userId, 'string');
        assert.strictEqual(typeof appstoreConfig.cloudronId, 'string');
        assert.strictEqual(typeof appstoreConfig.token, 'string');

        var url = config.apiServerOrigin() + '/api/v1/users/' + appstoreConfig.userId + '/cloudrons/' + appstoreConfig.cloudronId + '/alive';
        superagent.post(url).send(data).query({ accessToken: appstoreConfig.token }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, error));
            if (result.statusCode === 404) return callback(new CloudronError(CloudronError.NOT_FOUND));
            if (result.statusCode !== 201) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, util.format('Sending alive status failed. %s %j', result.status, result.body)));

            callback(null);
        });
    }

    // Caas Cloudrons do not store appstore credentials in their local database
    if (config.provider() === 'caas') {
        var url = config.apiServerOrigin() + '/api/v1/exchangeBoxTokenWithUserToken';
        superagent.post(url).query({ token: config.token() }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, error));
            if (result.statusCode !== 201) return callback(new CloudronError(CloudronError.EXTERNAL_ERROR, util.format('Token exchange failed. %s %j', result.status, result.body)));

            sendAliveStatusWithAppstoreConfig(data, result.body);
        });
    } else {
        settings.getAppstoreConfig(function (error, result) {
            if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

            if (!result.token) {
                debug('sendAliveStatus: Cloudron not yet registered');
                return callback(null);
            }

            sendAliveStatusWithAppstoreConfig(data, result);
        });
    }
}
