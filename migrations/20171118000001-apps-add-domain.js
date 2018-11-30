'use strict';

var async = require('async'),
    safe = require('safetydance');

exports.up = function(db, callback) {
    // first check precondtion of domain entry in settings
    db.all('SELECT * FROM settings WHERE name = ?', [ 'domain' ], function (error, result) {
        if (error) return callback(error);

        var domain = {};
        if (result[0]) domain = safe.JSON.parse(result[0].value) || {};

        async.series([
            db.runSql.bind(db, 'START TRANSACTION;'),
            function addAppsDomainColumn(done) {
                db.runSql('ALTER TABLE apps ADD COLUMN domain VARCHAR(128)', [], done);
            },
            function setAppDomain(done) {
                if (!domain.fqdn) return done(); // skip for new cloudrons without a domain
                db.runSql('UPDATE apps SET domain = ?', [ domain.fqdn ], done);
            },
            function addAppsLocationDomainUniqueConstraint(done) {
                db.runSql('ALTER TABLE apps ADD UNIQUE location_domain_unique_index (location, domain)', [], done);
            },
            function removePresetupAdminGroupIfNew(done) {
                // do not delete on update, will update the record in setMailboxesDomain()
                if (domain.fqdn) return done();

                // this will be finally created once we have a domain when we create the owner in user.js
                const ADMIN_GROUP_ID = 'admin'; // see constants.js
                db.runSql('DELETE FROM userGroups WHERE id = ?', [ ADMIN_GROUP_ID ], function (error) {
                    if (error) return done(error);

                    db.runSql('DELETE FROM mailboxes WHERE ownerId = ?', [ ADMIN_GROUP_ID ], done);
                });
            },
            function addMailboxesDomainColumn(done) {
                db.runSql('ALTER TABLE mailboxes ADD COLUMN domain VARCHAR(128)', [], done);
            },
            function setMailboxesDomain(done) {
                if (!domain.fqdn) return done(); // skip for new cloudrons without a domain
                db.runSql('UPDATE mailboxes SET domain = ?', [ domain.fqdn ], done);
            },
            function dropAppsLocationUniqueConstraint(done) {
                db.runSql('ALTER TABLE apps DROP INDEX location', [], done);
            },
            db.runSql.bind(db, 'COMMIT')
        ], callback);
    });
};

exports.down = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),
        function dropMailboxesDomainColumn(done) {
            db.runSql('ALTER TABLE mailboxes DROP COLUMN domain', [], done);
        },
        function dropLocationDomainUniqueConstraint(done) {
            db.runSql('ALTER TABLE apps DROP INDEX location_domain_unique_index', [], done);
        },
        function dropAppsDomainColumn(done) {
            db.runSql('ALTER TABLE apps DROP COLUMN domain', [], done);
        },
        function addAppsLocationUniqueConstraint(done) {
            db.runSql('ALTER TABLE apps ADD UNIQUE location (location)', [], done);
        },
        db.runSql.bind(db, 'COMMIT')
    ], callback);
};
