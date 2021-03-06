'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps ADD COLUMN enableBackup BOOLEAN DEFAULT 1', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP COLUMN enableBackup', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

