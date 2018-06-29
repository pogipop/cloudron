'use strict';

var async = require('async');

exports.up = function(db, callback) {
    db.all('SELECT id,location,domain from apps', [ ], function (error, results) {
        if (error) return done(error);

        var queries = [
            db.runSql.bind(db, 'START TRANSACTION;')
        ];

        results.forEach(function (app) {
            queries.push(db.runSql.bind(db, 'INSERT INTO subdomains (appId, domain, subdomain, type) VALUES (?, ?, ?, ?)', [ app.id, app.domain, app.location, 'primary' ]));
        });

        queries.push(db.runSql.bind(db, 'COMMIT'));

        async.series(queries, callback);
    });
};

exports.down = function(db, callback) {
    db.runSql('DELETE FROM subdomains', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
