'use strict';

exports = module.exports = {
    getApps: getApps,
    getApp: getApp,
    getAppVersion: getAppVersion,

    registerWithLoginCredentials: registerWithLoginCredentials,

    purchaseApp: purchaseApp,
    unpurchaseApp: unpurchaseApp,

    getSubscription: getSubscription,
    isFreePlan: isFreePlan,

    sendAliveStatus: sendAliveStatus,

    getAppUpdate: getAppUpdate,
    getBoxUpdate: getBoxUpdate,

    createTicket: createTicket,

    AppstoreError: AppstoreError
};

var apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
    custom = require('./custom.js'),
    debug = require('debug')('box:appstore'),
    domains = require('./domains.js'),
    eventlog = require('./eventlog.js'),
    mail = require('./mail.js'),
    os = require('os'),
    safe = require('safetydance'),
    semver = require('semver'),
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
AppstoreError.ALREADY_EXISTS = 'Already Exists';
AppstoreError.ACCESS_DENIED = 'Access Denied';
AppstoreError.NOT_FOUND = 'Not Found';
AppstoreError.PLAN_LIMIT = 'Plan limit reached'; // upstream 402 (subsciption_expired and subscription_required)
AppstoreError.LICENSE_ERROR = 'License Error'; // upstream 422 (no license, invalid license)
AppstoreError.INVALID_TOKEN = 'Invalid token'; // upstream 401 (invalid token)
AppstoreError.NOT_REGISTERED = 'Not registered'; // upstream 412 (no token, not set yet)
AppstoreError.ALREADY_REGISTERED = 'Already registered';

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

function getCloudronToken(callback) {
    assert.strictEqual(typeof callback, 'function');

    settings.getCloudronToken(function (error, token) {
        if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));
        if (!token) return callback(new AppstoreError(AppstoreError.NOT_REGISTERED));

        callback(null, token);
    });
}

function login(email, password, totpToken, callback) {
    assert.strictEqual(typeof email, 'string');
    assert.strictEqual(typeof password, 'string');
    assert.strictEqual(typeof totpToken, 'string');
    assert.strictEqual(typeof callback, 'function');

    var data = {
        email: email,
        password: password,
        totpToken: totpToken
    };

    const url = config.apiServerOrigin() + '/api/v1/login';
    superagent.post(url).send(data).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
        if (result.statusCode === 401) return callback(new AppstoreError(AppstoreError.ACCESS_DENIED));
        if (result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, `login status code: ${result.statusCode}`));

        callback(null, result.body); // { userId, accessToken }
    });
}

function registerUser(email, password, callback) {
    assert.strictEqual(typeof email, 'string');
    assert.strictEqual(typeof password, 'string');
    assert.strictEqual(typeof callback, 'function');

    var data = {
        email: email,
        password: password,
    };

    const url = config.apiServerOrigin() + '/api/v1/register_user';
    superagent.post(url).send(data).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
        if (result.statusCode === 409) return callback(new AppstoreError(AppstoreError.ALREADY_EXISTS));
        if (result.statusCode !== 201) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, `register status code: ${result.statusCode}`));

        callback(null);
    });
}

function getSubscription(callback) {
    assert.strictEqual(typeof callback, 'function');

    getCloudronToken(function (error, token) {
        if (error) return callback(error);

        const url = config.apiServerOrigin() + '/api/v1/subscription';
        superagent.get(url).query({ accessToken: token }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
            if (result.statusCode === 401) return callback(new AppstoreError(AppstoreError.INVALID_TOKEN));
            if (result.statusCode === 422) return callback(new AppstoreError(AppstoreError.LICENSE_ERROR));
            if (result.statusCode === 502) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, `Stripe error: ${error.message}`));
            if (result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, `Unknown error: ${error.message}`));

            callback(null, result.body); // { email, subscription }
        });
    });
}

function isFreePlan(subscription) {
    return !subscription || subscription.plan.id === 'free';
}

// See app.js install it will create a db record first but remove it again if appstore purchase fails
function purchaseApp(data, callback) {
    assert.strictEqual(typeof data, 'object'); // { appstoreId, manifestId, appId }
    assert(data.appstoreId || data.manifestId);
    assert.strictEqual(typeof data.appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    getCloudronToken(function (error, token) {
        if (error) return callback(error);

        const url = `${config.apiServerOrigin()}/api/v1/cloudronapps`;

        superagent.post(url).send(data).query({ accessToken: token }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
            if (result.statusCode === 404) return callback(new AppstoreError(AppstoreError.NOT_FOUND)); // appstoreId does not exist
            if (result.statusCode === 401) return callback(new AppstoreError(AppstoreError.INVALID_TOKEN));
            if (result.statusCode === 402) return callback(new AppstoreError(AppstoreError.PLAN_LIMIT, result.body.message));
            if (result.statusCode === 422) return callback(new AppstoreError(AppstoreError.LICENSE_ERROR, result.body.message));
            // 200 if already purchased, 201 is newly purchased
            if (result.statusCode !== 201 && result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('App purchase failed. %s %j', result.status, result.body)));

            callback(null);
        });
    });
}

function unpurchaseApp(appId, data, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof data, 'object'); // { appstoreId, manifestId }
    assert(data.appstoreId || data.manifestId);
    assert.strictEqual(typeof callback, 'function');

    getCloudronToken(function (error, token) {
        if (error) return callback(error);

        const url = `${config.apiServerOrigin()}/api/v1/cloudronapps/${appId}`;

        superagent.get(url).query({ accessToken: token }).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
            if (result.statusCode === 404) return callback(null);   // was never purchased
            if (result.statusCode === 401) return callback(new AppstoreError(AppstoreError.INVALID_TOKEN));
            if (result.statusCode === 422) return callback(new AppstoreError(AppstoreError.LICENSE_ERROR, result.body.message));
            if (result.statusCode !== 201 && result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('App unpurchase failed. %s %j', result.status, result.body)));

            superagent.del(url).send(data).query({ accessToken: token }).timeout(30 * 1000).end(function (error, result) {
                if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
                if (result.statusCode === 401) return callback(new AppstoreError(AppstoreError.INVALID_TOKEN));
                if (result.statusCode !== 204) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('App unpurchase failed. %s %j', result.status, result.body)));

                callback(null);
            });
        });
    });
}

function sendAliveStatus(callback) {
    callback = callback || NOOP_CALLBACK;

    var allSettings, allDomains, mailDomains, loginEvents;

    async.series([
        function (callback) {
            settings.getAll(function (error, result) {
                if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));
                allSettings = result;
                callback();
            });
        },
        function (callback) {
            domains.getAll(function (error, result) {
                if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));
                allDomains = result;
                callback();
            });
        },
        function (callback) {
            mail.getDomains(function (error, result) {
                if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));
                mailDomains = result;
                callback();
            });
        },
        function (callback) {
            eventlog.getAllPaged([ eventlog.ACTION_USER_LOGIN ], null, 1, 1, function (error, result) {
                if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));
                loginEvents = result;
                callback();
            });
        }
    ], function (error) {
        if (error) return callback(error);

        var backendSettings = {
            backupConfig: {
                provider: allSettings[settings.BACKUP_CONFIG_KEY].provider,
                hardlinks: !allSettings[settings.BACKUP_CONFIG_KEY].noHardlinks
            },
            domainConfig: {
                count: allDomains.length,
                domains: Array.from(new Set(allDomains.map(function (d) { return { domain: d.domain, provider: d.provider }; })))
            },
            mailConfig: {
                outboundCount: mailDomains.length,
                inboundCount: mailDomains.filter(function (d) { return d.enabled; }).length,
                catchAllCount: mailDomains.filter(function (d) { return d.catchAll.length !== 0; }).length,
                relayProviders: Array.from(new Set(mailDomains.map(function (d) { return d.relay.provider; })))
            },
            appAutoupdatePattern: allSettings[settings.APP_AUTOUPDATE_PATTERN_KEY],
            boxAutoupdatePattern: allSettings[settings.BOX_AUTOUPDATE_PATTERN_KEY],
            timeZone: allSettings[settings.TIME_ZONE_KEY],
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

        getCloudronToken(function (error, token) {
            if (error) return callback(error);

            const url = `${config.apiServerOrigin()}/api/v1/alive`;
            superagent.post(url).send(data).query({ accessToken: token }).timeout(30 * 1000).end(function (error, result) {
                if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
                if (result.statusCode === 404) return callback(new AppstoreError(AppstoreError.NOT_FOUND));
                if (result.statusCode === 401) return callback(new AppstoreError(AppstoreError.INVALID_TOKEN));
                if (result.statusCode === 422) return callback(new AppstoreError(AppstoreError.LICENSE_ERROR, result.body.message));
                if (result.statusCode !== 201) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Sending alive status failed. %s %j', result.status, result.body)));

                callback(null);
            });
        });
    });
}

function getBoxUpdate(callback) {
    assert.strictEqual(typeof callback, 'function');

    getCloudronToken(function (error, token) {
        if (error) return callback(error);

        const url = `${config.apiServerOrigin()}/api/v1/boxupdate`;

        superagent.get(url).query({ accessToken: token, boxVersion: config.version() }).timeout(10 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
            if (result.statusCode === 401) return callback(new AppstoreError(AppstoreError.INVALID_TOKEN));
            if (result.statusCode === 422) return callback(new AppstoreError(AppstoreError.LICENSE_ERROR, result.body.message));
            if (result.statusCode === 204) return callback(null); // no update
            if (result.statusCode !== 200 || !result.body) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response: %s %s', result.statusCode, result.text)));

            var updateInfo = result.body;

            if (!semver.valid(updateInfo.version) || semver.gt(config.version(), updateInfo.version)) {
                return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Invalid update version: %s %s', result.statusCode, result.text)));
            }

            // updateInfo: { version, changelog, sourceTarballUrl, sourceTarballSigUrl, boxVersionsUrl, boxVersionsSigUrl }
            if (!updateInfo.version || typeof updateInfo.version !== 'string') return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response (bad version): %s %s', result.statusCode, result.text)));
            if (!updateInfo.changelog || !Array.isArray(updateInfo.changelog)) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response (bad version): %s %s', result.statusCode, result.text)));
            if (!updateInfo.sourceTarballUrl || typeof updateInfo.sourceTarballUrl !== 'string') return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response (bad sourceTarballUrl): %s %s', result.statusCode, result.text)));
            if (!updateInfo.sourceTarballSigUrl || typeof updateInfo.sourceTarballSigUrl !== 'string') return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response (bad sourceTarballSigUrl): %s %s', result.statusCode, result.text)));
            if (!updateInfo.boxVersionsUrl || typeof updateInfo.boxVersionsUrl !== 'string') return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response (bad boxVersionsUrl): %s %s', result.statusCode, result.text)));
            if (!updateInfo.boxVersionsSigUrl || typeof updateInfo.boxVersionsSigUrl !== 'string') return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response (bad boxVersionsSigUrl): %s %s', result.statusCode, result.text)));

            callback(null, updateInfo);
        });
    });
}

function getAppUpdate(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    getCloudronToken(function (error, token) {
        if (error) return callback(error);

        const url = `${config.apiServerOrigin()}/api/v1/appupdate`;

        superagent.get(url).query({ accessToken: token, boxVersion: config.version(), appId: app.appStoreId, appVersion: app.manifest.version }).timeout(10 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error));
            if (result.statusCode === 401) return callback(new AppstoreError(AppstoreError.INVALID_TOKEN));
            if (result.statusCode === 422) return callback(new AppstoreError(AppstoreError.LICENSE_ERROR, result.body.message));
            if (result.statusCode === 204) return callback(null); // no update
            if (result.statusCode !== 200 || !result.body) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response: %s %s', result.statusCode, result.text)));

            const updateInfo = result.body;

            // for the appstore, x.y.z is the same as x.y.z-0 but in semver, x.y.z > x.y.z-0
            const curAppVersion = semver.prerelease(app.manifest.version) ? app.manifest.version : `${app.manifest.version}-0`;

            // do some sanity checks
            if (!safe.query(updateInfo, 'manifest.version') || semver.gt(curAppVersion, safe.query(updateInfo, 'manifest.version'))) {
                debug('Skipping malformed update of app %s version: %s. got %j', app.id, curAppVersion, updateInfo);
                return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Malformed update: %s %s', result.statusCode, result.text)));
            }

            // { id, creationDate, manifest }
            callback(null, updateInfo);
        });
    });
}

function subscribeCloudron(token, callback) {
    assert.strictEqual(typeof token, 'string');
    assert.strictEqual(typeof callback, 'function');

    const url = `${config.apiServerOrigin()}/api/v1/register_cloudron`;

    superagent.post(url).send({ domain: config.adminDomain() }).query({ accessToken: token }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
        if (result.statusCode !== 201) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, `Unable to register cloudron: ${error.message}`));

        // cloudronId, token, licenseKey
        if (!result.body.cloudronId) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, 'Invalid response - no cloudron id'));
        if (!result.body.cloudronToken) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, 'Invalid response - no token'));
        if (!result.body.licenseKey) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, 'Invalid response - no license'));

        async.series([
            settings.setCloudronId.bind(null, result.body.cloudronId),
            settings.setCloudronToken.bind(null, result.body.cloudronToken),
            settings.setLicenseKey.bind(null, result.body.licenseKey),
        ], function (error) {
            if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));

            debug(`registerCloudron: Cloudron registered with id ${result.body.cloudronId}`);

            callback();
        });
    });
}

function registerWithLoginCredentials(options, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    function maybeSignup(done) {
        if (!options.signup) return done();

        registerUser(options.email, options.password, done);
    }

    getCloudronToken(function (error) {
        if (!error || error.reason !== AppstoreError.NOT_REGISTERED) return callback(new AppstoreError(AppstoreError.ALREADY_REGISTERED));

        maybeSignup(function (error) {
            if (error) return callback(error);

            login(options.email, options.password, options.totpToken || '', function (error, result) {
                if (error) return callback(error);

                subscribeCloudron(result.accessToken, callback);
            });
        });
    });
}

function createTicket(info, callback) {
    assert.strictEqual(typeof info, 'object');
    assert.strictEqual(typeof info.email, 'string');
    assert.strictEqual(typeof info.displayName, 'string');
    assert.strictEqual(typeof info.type, 'string');
    assert.strictEqual(typeof info.subject, 'string');
    assert.strictEqual(typeof info.description, 'string');
    assert.strictEqual(typeof callback, 'function');

    function collectAppInfoIfNeeded(callback) {
        if (!info.appId) return callback();
        apps.get(info.appId, callback);
    }

    getCloudronToken(function (error, token) {
        if (error) return callback(error);

        collectAppInfoIfNeeded(function (error, result) {
            if (error) console.error('Unable to get app info', error);
            if (result) info.app = result;

            let url = config.apiServerOrigin() + '/api/v1/ticket';

            info.supportEmail = custom.supportEmail(); // destination address for tickets

            superagent.post(url).query({ accessToken: token }).send(info).timeout(10 * 1000).end(function (error, result) {
                if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
                if (result.statusCode === 401) return callback(new AppstoreError(AppstoreError.INVALID_TOKEN));
                if (result.statusCode === 422) return callback(new AppstoreError(AppstoreError.LICENSE_ERROR, result.body.message));
                if (result.statusCode !== 201) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response: %s %s', result.statusCode, result.text)));

                callback(null);
            });
        });
    });
}

function getApps(callback) {
    assert.strictEqual(typeof callback, 'function');

    getCloudronToken(function (error, token) {
        if (error) return callback(error);

        settings.getUnstableAppsConfig(function (error, unstable) {
            if (error) return callback(new AppstoreError(AppstoreError.INTERNAL_ERROR, error));
            const url = `${config.apiServerOrigin()}/api/v1/apps`;
            superagent.get(url).query({ accessToken: token, boxVersion: config.version(), unstable: unstable }).timeout(10 * 1000).end(function (error, result) {
                if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
                if (result.statusCode === 403 || result.statusCode === 401) return callback(new AppstoreError(AppstoreError.INVALID_TOKEN));
                if (result.statusCode === 422) return callback(new AppstoreError(AppstoreError.LICENSE_ERROR, result.body.message));
                if (result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('App listing failed. %s %j', result.status, result.body)));
                if (!result.body.apps) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('Bad response: %s %s', result.statusCode, result.text)));

                callback(null, result.body.apps);
            });
        });
    });
}

function getAppVersion(appId, version, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof version, 'string');
    assert.strictEqual(typeof callback, 'function');

    getCloudronToken(function (error, token) {
        if (error) return callback(error);

        let url = `${config.apiServerOrigin()}/api/v1/apps/${appId}`;
        if (version !== 'latest') url += `/versions/${version}`;

        superagent.get(url).query({ accessToken: token }).timeout(10 * 1000).end(function (error, result) {
            if (error && !error.response) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, error.message));
            if (result.statusCode === 403 || result.statusCode === 401) return callback(new AppstoreError(AppstoreError.INVALID_TOKEN));
            if (result.statusCode === 404) return callback(new AppstoreError(AppstoreError.NOT_FOUND));
            if (result.statusCode === 422) return callback(new AppstoreError(AppstoreError.LICENSE_ERROR, result.body.message));
            if (result.statusCode !== 200) return callback(new AppstoreError(AppstoreError.EXTERNAL_ERROR, util.format('App fetch failed. %s %j', result.status, result.body)));

            callback(null, result.body);
        });
    });
}

function getApp(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    getAppVersion(appId, 'latest', callback);
}
