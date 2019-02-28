'use strict';

var async = require('async');

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE notifications DROP COLUMN action', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE notifications ADD COLUMN action VARCHAR(512) NOT NULL', callback);
};
