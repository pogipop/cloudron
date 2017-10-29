'use strict';

var async = require('async'),
    safe = require('safetydance');

exports.up = function(db, callback) {
    var fqdn, zoneName, configJson;

    async.series([
        function gatherDomain(done) {
            db.all('SELECT * FROM settings WHERE name = ?', [ 'domain' ], function (error, result) {
                if (error) return done(error);
                if (result.length === 0 || !result[0].value) return done(new Error('no domain entry in settings table'));

                var domain = safe.JSON.parse(result[0].value);
                if (!domain) return done(new Error('Unable to parse domain entry from settings table. Invalid JSON.'));

                // if no domain has been set we can't continue
                if (!domain.fqdn) return done(new Error('no fqdn value in domain settings entry'));

                fqdn = domain.fqdn;
                zoneName = domain.zoneName || fqdn;

                done();
            });
        },
        function gatherDNSConfig(done) {
            db.all('SELECT * FROM settings WHERE name = ?', [ 'dns_config' ], function (error, result) {
                if (error ) return done(error);

                configJson = (result[0] && result[0].value) ? result[0].value : JSON.stringify({ provider: 'manual'});

                done();
            });
        },
        db.runSql.bind(db, 'START TRANSACTION;'),
        function createDomainsTable(done) {
            var cmd = `
                CREATE TABLE domains(
                domain VARCHAR(128) NOT NULL UNIQUE,
                zoneName VARCHAR(128) NOT NULL,
                configJson TEXT,
                PRIMARY KEY (domain)) CHARACTER SET utf8 COLLATE utf8_bin
            `;

            db.runSql(cmd, [], done);
        },
        function addInitialDomain(done) {
            db.runSql('INSERT INTO domains (domain, zoneName, configJson) VALUES (?, ?, ?)', [ fqdn, zoneName, configJson ], done);
        },
        db.runSql.bind(db, 'COMMIT')
    ], callback);
};

exports.down = function(db, callback) {
    db.runSql('DROP TABLE domains', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
