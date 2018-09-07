'use strict';

var async = require('async');

exports.up = function(db, callback) {
    db.all('SELECT * from apps', [ ], function (error, results) {
        if (error) return callback(error);

        var queries = [
            db.runSql.bind(db, 'START TRANSACTION;')
        ];

        results.forEach(function (app) {
            queries.push(db.runSql.bind(db, 'INSERT INTO subdomains (appId, domain, subdomain, type, dnsRecordId) VALUES (?, ?, ?, ?, ?)', [ app.id, app.domain, app.location, 'primary', app.dnsRecordId ]));
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
