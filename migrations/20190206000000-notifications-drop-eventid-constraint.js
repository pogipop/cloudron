'use strict';

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),
        // WARNING in the future always give constraints proper names to not rely on automatic ones
        db.runSql.bind(db, 'ALTER TABLE notifications DROP FOREIGN KEY notifications_ibfk_1'),
        db.runSql.bind(db, 'ALTER TABLE notifications MODIFY eventId VARCHAR(128)'),
        db.runSql.bind(db, 'COMMIT')
    ], callback);
};

exports.down = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),
        db.runSql.bind(db, 'ALTER TABLE notifications MODIFY eventId VARCHAR(128) NOT NULL'),
        db.runSql.bind(db, 'ALTER TABLE notifications ADD FOREIGN KEY(eventId) REFERENCES eventlog(id)'),
        db.runSql.bind(db, 'COMMIT')
    ], callback);
};
