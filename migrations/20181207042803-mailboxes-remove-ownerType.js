'use strict';

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),

        function migrateMailboxNames(done) {
            db.all('SELECT * FROM mailboxes', function (error, mailboxes) {
                if (error) return done(error);

                async.eachSeries(mailboxes, function (mailbox, iteratorDone) {
                    if (mailbox.ownerType !== 'app') return iteratorDone();

                    db.runSql('DELETE FROM mailboxes WHERE name = ?', [ mailbox.name ], iteratorDone);
                }, done);
            });
        },

        db.runSql.bind(db, 'COMMIT'),
        db.runSql.bind(db, 'ALTER TABLE mailboxes DROP COLUMN ownerType')
    ], callback);
};

exports.down = function(db, callback) {
    callback();
};
