'use strict';

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),
        db.runSql.bind(db, 'ALTER TABLE apps ADD COLUMN ownerId VARCHAR(128)'),
        function (next) {
            db.all('SELECT id FROM users ORDER BY createdAt LIMIT 1', [ ], function (error, results) {
                if (error || results.length === 0) return next(error);

                var ownerId = results[0].id;
                db.runSql('UPDATE apps SET ownerId=?', [ ownerId ], next);
            });
        },
        db.runSql.bind(db, 'ALTER TABLE apps MODIFY ownerId VARCHAR(128) NOT NULL'),
        db.runSql.bind(db, 'ALTER TABLE apps ADD CONSTRAINT apps_owner_constraint FOREIGN KEY(ownerId) REFERENCES users(id)'),
        db.runSql.bind(db, 'COMMIT'),
    ], callback);
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP COLUMN ownerId', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
