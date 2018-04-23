'use strict';

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),
        db.runSql.bind(db, 'ALTER TABLE mailboxes ADD COLUMN type VARCHAR(16)'),
        function addMailboxType(done) {
            db.all('SELECT * from mailboxes', [ ], function (error, results) {
                if (error) return done(error);

                async.eachSeries(results, function (mailbox, iteratorCallback) {
                    let type = 'mailbox';
                    if (mailbox.aliasTarget) {
                        type = 'alias';
                    } else if (mailbox.membersJson) {
                        type = 'list';
                    }
                    db.runSql('UPDATE mailboxes SET type = ? WHERE name = ? AND domain = ?', [ type, mailbox.name, mailbox.domain ], iteratorCallback);
                }, done);
            });
        },
        db.runSql.bind(db, 'ALTER TABLE mailboxes MODIFY type VARCHAR(16) NOT NULL'),
        db.runSql.bind(db, 'COMMIT')
    ], callback);
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE mailboxes DROP COLUMN membersJson', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
