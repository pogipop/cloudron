'use strict';

var async = require('async'),
    safe = require('safetydance'),
    tld = require('tldjs');

exports.up = function(db, callback) {
    var fqdn, zoneName, configJson;

    async.series([
        function gatherDomain(done) {
            db.all('SELECT * FROM settings WHERE name = ?', [ 'domain' ], function (error, result) {
                if (error) return done(error);

                var domain = {};
                if (result[0]) domain = safe.JSON.parse(result[0].value) || {};

                fqdn = domain.fqdn || ''; // will be null pre-setup
                zoneName = domain.zoneName || tld.getDomain(fqdn) || fqdn;

                done();
            });
        },
        function gatherDNSConfig(done) {
            db.all('SELECT * FROM settings WHERE name = ?', [ 'dns_config' ], function (error, result) {
                if (error) return done(error);

                configJson = (result[0] && result[0].value) ? result[0].value : JSON.stringify({ provider: 'manual'});

                // caas dns config needs an fqdn
                var config = JSON.parse(configJson);
                if (config.provider === 'caas') config.fqdn = fqdn;
                configJson = JSON.stringify(config);

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
            if (!fqdn) return done();

            db.runSql('INSERT INTO domains (domain, zoneName, configJson) VALUES (?, ?, ?)', [ fqdn, zoneName, configJson ], done);
        },
        db.runSql.bind(db, 'COMMIT')
    ], callback);
};

exports.down = function(db, callback) {
    db.runSql('DROP TABLE domains', callback);
};
