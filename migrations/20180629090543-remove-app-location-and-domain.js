'use strict';

var async = require('async');

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP INDEX location_domain_unique_index, DROP FOREIGN KEY apps_domain_constraint, DROP COLUMN domain, DROP COLUMN location', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.all('SELECT * from subdomains WHERE type = ?', [ 'primary' ], function (error, results) {
        if (error) return callback(error);

        var cmd = 'ALTER TABLE apps'
        + ' ADD COLUMN location VARCHAR(128) NOT NULL,'
        + ' ADD COLUMN domain VARCHAR(128) NOT NULL';

        db.runSql(cmd, function (error) {
            if (error) return callback(error);

            var queries = [ db.runSql.bind(db, 'START TRANSACTION;') ];
            results.forEach(function (subdomains) {
                queries.push(db.runSql.bind(db, 'UPDATE apps SET domain = ?, location = ? WHERE id = ?', [ subdomains.domain, subdomains.domain, subdomains.appId ]));
            });
            queries.push(db.runSql.bind(db, 'COMMIT'));

            async.series(queries, function (error) {
                if (error) return callback(error);

                var cmd = 'ALTER TABLE apps'
                + ' ADD CONSTRAINT apps_domain_constraint FOREIGN KEY(domain) REFERENCES domains(domain),'
                + ' ADD UNIQUE location_domain_unique_index (location, domain)';

                db.runSql(cmd, callback);
            });
        });
    });
};
