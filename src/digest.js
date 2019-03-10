'use strict';

var assert = require('assert'),
    async = require('async'),
    debug = require('debug')('box:digest'),
    eventlog = require('./eventlog.js'),
    mailer = require('./mailer.js'),
    settings = require('./settings.js'),
    updatechecker = require('./updatechecker.js'),
    users = require('./users.js');

exports = module.exports = {
    send: send
};

function send(callback) {
    assert.strictEqual(typeof callback, 'function');

    settings.getEmailDigest(function (error, enabled) {
        if (error) return callback(error);

        if (!enabled) {
            debug('send: email digest is disabled');
            return callback();
        }

        var updateInfo = updatechecker.getUpdateInfo();
        var pendingAppUpdates = updateInfo.apps || {};
        pendingAppUpdates = Object.keys(pendingAppUpdates).map(function (key) { return pendingAppUpdates[key]; });

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
                pendingAppUpdates: pendingAppUpdates,
                pendingBoxUpdate: updateInfo.box || null,

                finishedAppUpdates: appUpdates,
                finishedBoxUpdates: boxUpdates,

                certRenewals: certRenewals,
                finishedBackups: finishedBackups, // only the successful backups
                usersAdded: usersAdded,
                usersRemoved: usersRemoved // unused because we don't have username to work with
            };

            debug('send: sending digest email', info);

            users.getAllAdmins(function (error, admins) {
                if (error) return callback(error);

                async.eachSeries(admins, (admin, done) => mailer.sendDigest(admin.email, info, done), callback);
            });
        });
    });
}
