'use strict';

var async = require('async');

exports.up = function(db, callback) {
    // first check precondtion of domain entry in settings
    db.all('SELECT * FROM domains', [ ], function (error, domains) {
        if (error) return callback(error);

        async.series([
            db.runSql.bind(db, 'START TRANSACTION;'),
            db.runSql.bind(db, 'ALTER TABLE domains ADD COLUMN provider VARCHAR(16) DEFAULT ""'),
            function setProvider(done) {
                async.eachSeries(domains, function (domain, iteratorCallback) {
                    var config = JSON.parse(domain.configJson);
                    var provider = config.provider;
                    delete config.provider;

                    db.runSql('UPDATE domains SET provider = ?, configJson = ? WHERE domain = ?', [ provider, JSON.stringify(config), domain.domain ], iteratorCallback);
                }, done);
            },
            db.runSql.bind(db, 'ALTER TABLE domains MODIFY provider VARCHAR(16) NOT NULL'),
            db.runSql.bind(db, 'COMMIT')
        ], callback);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE domains DROP COLUMN provider', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
