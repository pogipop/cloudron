'use strict';

var async = require('async'),
    crypto = require('crypto'),
    fs = require('fs'),
    os = require('os'),
    path = require('path'),
    safe = require('safetydance'),
    tldjs = require('tldjs');

exports.up = function(db, callback) {
    db.all('SELECT * FROM apps, subdomains WHERE apps.id=subdomains.appId AND type="primary"', function (error, apps) {
        if (error) return callback(error);

        async.eachSeries(apps, function (app, iteratorDone) {
            if (app.mailboxName) return iteratorDone();

            const mailboxName = (app.subdomain ? app.subdomain : JSON.parse(app.manifestJson).title.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')) + '.app';

            db.runSql('UPDATE apps SET mailboxName=? WHERE id=?', [ mailboxName, app.id ], iteratorDone);
        }, callback);
    });
};

exports.down = function(db, callback) {
    callback();
};
