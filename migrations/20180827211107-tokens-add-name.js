'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE tokens ADD COLUMN name VARCHAR(64) DEFAULT ""', [], callback);
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE tokens DROP COLUMN name', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
