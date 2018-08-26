'use strict';

var async = require('async');

exports.up = function(db, callback) {
    // first check precondtion of domain entry in settings
    db.all('SELECT * FROM domains', [ ], function (error, domains) {
        if (error) return callback(error);

        let caasDomains = domains.filter(function (d) { return d.provider === 'caas'; });

        async.eachSeries(caasDomains, function (domain, iteratorCallback) {
            let config = JSON.parse(domain.configJson);
            config.hyphenatedSubdomains = true;

            db.runSql('UPDATE domains SET configJson = ? WHERE domain = ?', [ JSON.stringify(config), domain.domain ], iteratorCallback);
        }, callback);
    });
};

exports.down = function(db, callback) {
    callback();
};
