'use strict';

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'ALTER TABLE apps ADD COLUMN mailboxName VARCHAR(128)'),
        db.runSql.bind(db, 'START TRANSACTION;'),

        function migrateMailboxNames(done) {
            db.all('SELECT * FROM mailboxes', function (error, mailboxes) {
                if (error) return done(error);

                async.eachSeries(mailboxes, function (mailbox, iteratorDone) {
                    if (mailbox.ownerType !== 'app') return iteratorDone();

                    db.runSql('UPDATE apps SET mailboxName = ? WHERE id = ?', [ mailbox.name, mailbox.ownerId ], iteratorDone);
                }, done);
            });
        },

        db.runSql.bind(db, 'COMMIT')
    ], callback);
};

exports.down = function(db, callback) {
    callback();
};
