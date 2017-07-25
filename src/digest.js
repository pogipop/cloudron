'use strict';

var assert = require('assert'),
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

        eventlog.getByActionLastWeek(eventlog.ACTION_APP_UPDATE, function (error, appUpdates) {
            if (error) return console.error(error);

            eventlog.getByActionLastWeek(eventlog.ACTION_UPDATE, function (error, boxUpdates) {
                if (error) return console.error(error);

                var info = {
                    pendingAppUpdates: pendingAppUpdates,
                    pendingBoxUpdate: updateInfo.box || null,

                    finishedAppUpdates: (appUpdates || []).map(function (e) { return e.data; }),
                    finishedBoxUpdates: (boxUpdates || []).map(function (e) { return e.data; })
                };

                if (info.pendingAppUpdates.length || info.pendingBoxUpdate || info.finishedAppUpdates.length || info.finishedBoxUpdates.length) {
                    debug('maybeSend: sending digest email', info);
                    mailer.sendDigest(info);
                } else {
                    debug('maybeSend: nothing happened, NOT sending digest email');
                }

            });
        });
    });
}
