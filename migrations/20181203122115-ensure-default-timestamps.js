'use strict';

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'ALTER TABLE apps MODIFY creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'),
        db.runSql.bind(db, 'ALTER TABLE apps MODIFY updateTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'),
        db.runSql.bind(db, 'ALTER TABLE eventlog MODIFY creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'),
        db.runSql.bind(db, 'ALTER TABLE backups MODIFY creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'),
        db.runSql.bind(db, 'ALTER TABLE mailboxes MODIFY creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'),
    ], callback);
};

exports.down = function(db, callback) {
    callback();
};
