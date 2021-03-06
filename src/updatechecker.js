'use strict';

exports = module.exports = {
    checkAppUpdates: checkAppUpdates,
    checkBoxUpdates: checkBoxUpdates,

    getUpdateInfo: getUpdateInfo,
    resetUpdateInfo: resetUpdateInfo,
    resetAppUpdateInfo: resetAppUpdateInfo,

    _setUpdateInfo: setUpdateInfo
};

var apps = require('./apps.js'),
    appstore = require('./appstore.js'),
    assert = require('assert'),
    async = require('async'),
    constants = require('./constants.js'),
    debug = require('debug')('box:updatechecker'),
    mailer = require('./mailer.js'),
    notifications = require('./notifications.js'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    users = require('./users.js');

var gAppUpdateInfo = { }, // id -> update info { creationDate, manifest }
    gBoxUpdateInfo = null; // { version, changelog, upgrade, sourceTarballUrl }

function loadState() {
    var state = safe.JSON.parse(safe.fs.readFileSync(paths.UPDATE_CHECKER_FILE, 'utf8'));
    return state || { };
}

function saveState(mailedUser) {
    safe.fs.writeFileSync(paths.UPDATE_CHECKER_FILE, JSON.stringify(mailedUser, null, 4), 'utf8');
}

function getUpdateInfo() {
    return {
        apps: gAppUpdateInfo,
        box: gBoxUpdateInfo
    };
}

function setUpdateInfo(info) {
    gBoxUpdateInfo = info.box;
    gAppUpdateInfo = info.apps;
}

function resetUpdateInfo() {
    gBoxUpdateInfo = null;
    resetAppUpdateInfo();
}

// If no appId provided all apps are reset
function resetAppUpdateInfo(appId) {
    if (!appId) {
        gAppUpdateInfo = {};
    } else {
        delete gAppUpdateInfo[appId];
    }
}

function checkAppUpdates(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Checking App Updates');

    gAppUpdateInfo = { };
    var oldState = loadState();
    var newState = { };  // create new state so that old app ids are removed

    settings.getAppAutoupdatePattern(function (error, result) {
        if (error) return callback(error);
        const autoupdatesEnabled = (result !== constants.AUTOUPDATE_PATTERN_NEVER);

        var notificationPending = [];

        apps.getAll(function (error, result) {
            if (error) return callback(error);

            async.eachSeries(result, function (app, iteratorDone) {
                if (app.appStoreId === '') return iteratorDone(); // appStoreId can be '' for dev apps

                appstore.getAppUpdate(app, function (error, updateInfo) {
                    if (error) {
                        debug('Error getting app update info for %s', app.id, error);
                        return iteratorDone();  // continue to next
                    }

                    // skip if no next version is found
                    if (!updateInfo) {
                        delete gAppUpdateInfo[app.id];
                        return iteratorDone();
                    }

                    gAppUpdateInfo[app.id] = updateInfo;

                    // decide whether to send email
                    newState[app.id] = updateInfo.manifest.version;

                    if (oldState[app.id] === newState[app.id]) {
                        debug('Skipping notification of app update %s since user was already notified', app.id);
                        return iteratorDone();
                    }

                    const updateIsBlocked = apps.canAutoupdateApp(app, updateInfo.manifest);
                    if (autoupdatesEnabled && !updateIsBlocked) return iteratorDone();

                    debug('Notifying of app update for %s from %s to %s', app.id, app.manifest.version, updateInfo.manifest.version);
                    notificationPending.push({
                        app: app,
                        updateInfo: updateInfo
                    });

                    iteratorDone();
                });
            }, function () {
                newState.box = loadState().box; // preserve the latest box state information
                saveState(newState);

                if (notificationPending.length === 0) return callback();

                users.getAllAdmins(function (error, admins) {
                    if (error) {
                        console.error(error);
                        return callback();
                    }

                    async.eachSeries(admins, (admin, done) => mailer.appUpdatesAvailable(admin.email, notificationPending, true /* subscription */, done), callback);
                });
            });
        });
    });
}

function checkBoxUpdates(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Checking Box Updates');

    gBoxUpdateInfo = null;

    appstore.getBoxUpdate(function (error, updateInfo) {
        if (error || !updateInfo) return callback(error);

        gBoxUpdateInfo = updateInfo;

        // decide whether to send email
        var state = loadState();

        if (state.box === gBoxUpdateInfo.version) {
            debug('Skipping notification of box update as user was already notified');
            return callback();
        }

        const changelog = updateInfo.changelog.map((m) => `* ${m}\n`).join('');

        const message = `Changelog:\n${changelog}\n\nClick [here](/#/settings) to update.\n\n`;

        notifications.alert(notifications.ALERT_BOX_UPDATE, `Cloudron v${updateInfo.version} is available`, message, function (error) {
            if (error) return callback(error);

            state.box = updateInfo.version;
            saveState(state);

            callback();
        });
    });
}
