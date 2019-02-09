'use strict';

let async = require('async');

exports.up = function(db, callback) {
    db.runSql('SELECT * FROM domains', function (error, domains) {
        if (error) return callback(error);

        async.eachSeries(domains, function (domain, iteratorCallback) {
            if (domain.provider !== 'namecheap') return iteratorCallback();

            let config = JSON.parse(domain.configJson);
            config.token = config.apiKey;
            delete config.apiKey;

            db.runSql('UPDATE domains SET configJson = ? WHERE domain = ?', [ JSON.stringify(config), domain.domain ], iteratorCallback);
        }, callback);
    });
};

exports.down = function(db, callback) {
    callback();
};
