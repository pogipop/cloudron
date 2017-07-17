'use strict';

exports = module.exports = {
    checkAppUpdates: checkAppUpdates,
    checkBoxUpdates: checkBoxUpdates,

    getUpdateInfo: getUpdateInfo,
    resetUpdateInfo: resetUpdateInfo,
    resetAppUpdateInfo: resetAppUpdateInfo
};

var apps = require('./apps.js'),
    appstore = require('./appstore.js'),
    async = require('async'),
    constants = require('./constants.js'),
    debug = require('debug')('box:updatechecker'),
    mailer = require('./mailer.js'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    semver = require('semver'),
    settings = require('./settings.js');

var gAppUpdateInfo = { }, // id -> update info { creationDate, manifest }
    gBoxUpdateInfo = null; // { version, changelog, upgrade, sourceTarballUrl }

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

function loadState() {
    var state = safe.JSON.parse(safe.fs.readFileSync(paths.UPDATE_CHECKER_FILE, 'utf8'));
    return state || {};
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
    callback = callback || NOOP_CALLBACK; // null when called from a timer task

    debug('Checking App Updates');

    gAppUpdateInfo = { };
    var oldState = loadState();
    var newState = { };  // create new state so that old app ids are removed

    apps.getAll(function (error, apps) {
        if (error) return callback(error);

        async.eachSeries(apps, function (app, iteratorDone) {
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

                if (!safe.query(updateInfo, 'manifest.version')) {
                    debug('Skipping malformed update of app %s. got %j', app.id, updateInfo);
                    delete gAppUpdateInfo[app.id];
                    return iteratorDone();
                }

                gAppUpdateInfo[app.id] = updateInfo;

                // decide whether to send email
                newState[app.id] = updateInfo.manifest.version;

                if (oldState[app.id] === newState[app.id]) {
                    debug('Skipping notification of app update %s since user was already notified', app.id);
                } else {
                    // only send notifications if update pattern is 'never'
                    settings.getAutoupdatePattern(function (error, result) {
                        if (error) return debug(error);
                        if (result !== constants.AUTOUPDATE_PATTERN_NEVER) return;

                        debug('Notifying user of app update for %s from %s to %s', app.id, app.manifest.version, updateInfo.manifest.version);

                        mailer.appUpdateAvailable(app, updateInfo);
                    });
                }

                iteratorDone();
            });
        }, function () {
            // preserve the latest box state information
            newState.box = loadState().box;
            newState.boxTimestamp = loadState().boxTimestamp;

            saveState(newState);
            callback();
        });
    });
}

function checkBoxUpdates(callback) {
    callback = callback || NOOP_CALLBACK; // null when called from a timer task

    debug('Checking Box Updates');

    gBoxUpdateInfo = null;

    appstore.getBoxUpdate(function (error, updateInfo) {
        if (error || !updateInfo) return callback(error);

        settings.getUpdateConfig(function (error, updateConfig) {
            if (error) return callback(error);

            var isPrerelease = semver.parse(updateInfo.version).prerelease.length !== 0;

            if (isPrerelease && !updateConfig.prerelease) {
                debug('Skipping update %s since this box does not want prereleases', updateInfo.version);
                return callback();
            }

            gBoxUpdateInfo = updateInfo;

            // decide whether to send email
            var state = loadState();

            const NOTIFICATION_OFFSET = 1000 * 60 * 60 * 24 * 5;    // 5 days

            if (state.box === gBoxUpdateInfo.version && state.boxTimestamp > Date.now() - NOTIFICATION_OFFSET) {
                debug('Skipping notification of box update as user was already notified within the last 5 days');
                return callback();
            }

            state.boxTimestamp = Date.now();
            state.box = updateInfo.version;

            mailer.boxUpdateAvailable(updateInfo.version, updateInfo.changelog);

            saveState(state);

            callback();
        });
    });
}
