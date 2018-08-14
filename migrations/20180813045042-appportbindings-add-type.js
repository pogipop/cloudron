'use strict';

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'ALTER TABLE appPortBindings ADD COLUMN type VARCHAR(8) NOT NULL DEFAULT "tcp"'),
        db.runSql.bind(db, 'ALTER TABLE appPortBindings DROP INDEX hostPort'), // this drops the unique constraint
        db.runSql.bind(db, 'ALTER TABLE appPortBindings DROP PRIMARY KEY, ADD PRIMARY KEY(hostPort, type)')
    ], callback);
};

exports.down = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'ALTER TABLE appPortBindings DROP PRIMARY KEY, ADD PRIMARY KEY(hostPort)'),
        db.runSql.bind(db, 'ALTER TABLE appPortBindings DROP COLUMN type')
    ], callback);
};
