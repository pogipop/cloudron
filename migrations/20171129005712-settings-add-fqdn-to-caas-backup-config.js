'use strict';

var async = require('async');

exports.up = function(db, callback) {
    db.all('SELECT * FROM domains', function (error, domains) {
        if (error) return callback(error);

        var caasDomains = domains.filter(function (d) { return JSON.parse(d.configJson).provider === 'caas'; });
        if (caasDomains.length === 0) return callback();
        var caasDomain = caasDomains[0].domain;

        db.all('SELECT * FROM settings WHERE name=?', [ 'backup_config' ], function (error, settings) {
            if (error) return callback(error);

            var setting = settings[0];
            var config = JSON.parse(setting.value);
            config.fqdn = caasDomain;

            db.runSql('UPDATE settings SET value=? WHERE name=?', [ JSON.stringify(config), setting.name ], callback);
        });
    });
};

exports.down = function(db, callback) {
    callback();
};
