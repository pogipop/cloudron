'use strict';

var appstore = require('./appstore.js'),
    debug = require('debug')('box:digest'),
    eventlog = require('./eventlog.js'),
    updatechecker = require('./updatechecker.js'),
    mailer = require('./mailer.js'),
    settings = require('./settings.js');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

exports = module.exports = {
    maybeSend: maybeSend
};

function maybeSend(callback) {
    callback = callback || NOOP_CALLBACK;

    settings.getEmailDigest(function (error, enabled) {
        if (error) return callback(error);

        if (!enabled) {
            debug('Email digest is disabled');
            return callback();
        }

        var updateInfo = updatechecker.getUpdateInfo();
        var pendingAppUpdates = updateInfo.apps || {};
        pendingAppUpdates = Object.keys(pendingAppUpdates).map(function (key) { return pendingAppUpdates[key]; });

        appstore.getSubscription(function (error, result) {
            if (error) debug('Error getting subscription:', error);

            var hasSubscription = result && result.plan.id !== 'free';

            eventlog.getByCreationTime(new Date(new Date() - 7*86400000), function (error, events) {
                if (error) return callback(error);

                var appUpdates = events.filter(function (e) { return e.action === eventlog.ACTION_APP_UPDATE; }).map(function (e) { return e.data; });
                var boxUpdates = events.filter(function (e) { return e.action === eventlog.ACTION_UPDATE; }).map(function (e) { return e.data; });
                var certRenewals = events.filter(function (e) { return e.action === eventlog.ACTION_CERTIFICATE_RENEWAL; }).map(function (e) { return e.data; });
                var usersAdded = events.filter(function (e) { return e.action === eventlog.ACTION_USER_ADD; }).map(function (e) { return e.data; });
                var usersRemoved = events.filter(function (e) { return e.action === eventlog.ACTION_USER_REMOVE; }).map(function (e) { return e.data; });
                var finishedBackups = events.filter(function (e) { return e.action === eventlog.ACTION_BACKUP_FINISH && !e.errorMessage; }).map(function (e) { return e.data; });

                if (error) return callback(error);

                var info = {
                    hasSubscription: hasSubscription,

                    pendingAppUpdates: pendingAppUpdates,
                    pendingBoxUpdate: updateInfo.box || null,

                    finishedAppUpdates: appUpdates,
                    finishedBoxUpdates: boxUpdates,

                    certRenewals: certRenewals,
                    finishedBackups: finishedBackups, // only the successful backups
                    usersAdded: usersAdded,
                    usersRemoved: usersRemoved // unused because we don't have username to work with
                };

                // always send digest for backup failure notification
                debug('maybeSend: sending digest email', info);
                mailer.sendDigest(info);

                callback();
            });
        });
    });
}
