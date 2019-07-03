'use strict';

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'ALTER TABLE apps DROP FOREIGN KEY apps_owner_constraint'),
        db.runSql.bind(db, 'ALTER TABLE apps DROP COLUMN ownerId')
    ], callback);
};

exports.down = function(db, callback) {
    callback();
};
