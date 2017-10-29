'use strict';

var async = require('async'),
    safe = require('safetydance');

exports.up = function(db, callback) {
    function prepareTestSetupIfNeeded(done) {
        if (process.env.BOX_ENV !== 'test') return done();

        const settings = [
            [ 'domain', JSON.stringify({ fqdn: 'example.com', zoneName: 'example.com' })],
            [ 'dns_config', JSON.stringify({ provider: 'manual', wildcard: true })]
        ];

        async.eachSeries(settings, function (setting, callback) {
            db.runSql('INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)', setting, callback);
        }, done);
    }

    prepareTestSetupIfNeeded(function (error) {
        if (error) return callback(error);

        // first check precondtion of domain entry in settings
        db.all('SELECT * FROM settings WHERE name = ?', [ 'domain' ], function (error, result) {
            if (error) return callback(error);
            if (result.length === 0 || !result[0].value) return callback(new Error('no domain entry in settings table'));

            var domain = safe.JSON.parse(result[0].value);
            if (!domain) return callback(new Error('Unable to parse domain entry from settings table. Invalid JSON.'));

            // if no domain has been set we can't continue
            if (!domain.fqdn) return callback(new Error('no fqdn value in domain settings entry'));

            async.series([
                db.runSql.bind(db, 'START TRANSACTION;'),
                function addAppsDomainColumn(done) {
                    db.runSql('ALTER TABLE apps ADD COLUMN domain VARCHAR(128)', [], done);
                },
                function setAppDomain(done) {
                    db.runSql('UPDATE apps SET domain = ?', [ domain.fqdn ], done);
                },
                function addAppsLocationDomainUniqueConstraint(done) {
                    db.runSql('ALTER TABLE apps ADD UNIQUE location_domain_unique_index (location, domain)', [], done);
                },
                function addMailboxesDomainColumn(done) {
                    db.runSql('ALTER TABLE mailboxes ADD COLUMN domain VARCHAR(128)', [], done);
                },
                function setMailboxesDomain(done) {
                    db.runSql('UPDATE mailboxes SET domain = ?', [ domain.fqdn ], done);
                },
                function dropAppsLocationUniqueConstraint(done) {
                    db.runSql('ALTER TABLE apps DROP INDEX location', [], done);
                },
                db.runSql.bind(db, 'COMMIT')
            ], callback);
        });
    });
};

exports.down = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),
        function dropMailboxesDomainColumn(done) {
            // done();
            db.runSql('ALTER TABLE mailboxes DROP COLUMN domain', [], done);
        },
        function dropLocationDomainUniqueConstraint(done) {
            // done();
            db.runSql('ALTER TABLE apps DROP INDEX location_domain_unique_index', [], done);
        },
        function dropAppsDomainColumn(done) {
            // done();
            db.runSql('ALTER TABLE apps DROP COLUMN domain', [], done);
        },
        function addAppsLocationUniqueConstraint(done) {
            // done();
            db.runSql('ALTER TABLE apps ADD UNIQUE location (location)', [], done);
        },
        db.runSql.bind(db, 'COMMIT')
    ], callback);
};
