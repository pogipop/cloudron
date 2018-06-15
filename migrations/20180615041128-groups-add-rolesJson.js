'use strict';

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),
        db.runSql.bind(db, 'ALTER TABLE groups ADD COLUMN rolesJson TEXT'),
        db.runSql.bind(db, 'UPDATE groups SET rolesJson=? WHERE id=?', JSON.stringify([ 'owner' ]), 'admin'),
        db.runSql.bind(db, 'COMMIT')
    ], callback);
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE groups DROP COLUMN rolesJson', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
