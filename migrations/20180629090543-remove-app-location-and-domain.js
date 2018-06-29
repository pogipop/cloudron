'use strict';

var async = require('async');

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP INDEX location_domain_unique_index, DROP FOREIGN KEY apps_domain_constraint, DROP COLUMN domain, DROP COLUMN location, DROP COLUMN dnsRecordId', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.all('SELECT * from subdomains WHERE type = ?', [ 'primary' ], function (error, results) {
        if (error) return callback(error);

        var cmd = 'ALTER TABLE apps'
        + ' ADD COLUMN location VARCHAR(128),'
        + ' ADD COLUMN domain VARCHAR(128),'
        + ' ADD COLUMN dnsRecordId VARCHAR(512)';

        db.runSql(cmd, function (error) {
            if (error) return callback(error);

            var queries = [ db.runSql.bind(db, 'START TRANSACTION;') ];
            results.forEach(function (d) {
                queries.push(db.runSql.bind(db, 'UPDATE apps SET domain = ?, location = ?, dnsRecordId = ? WHERE id = ?', [ d.domain, d.subdomain, d.appId, d.dnsRecordId ]));
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
