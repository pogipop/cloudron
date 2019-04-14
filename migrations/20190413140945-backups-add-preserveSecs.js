'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE backups ADD COLUMN preserveSecs INTEGER DEFAULT 0', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE backups DROP COLUMN preserveSecs', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
