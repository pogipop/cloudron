'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE backups ADD COLUMN format VARCHAR(16) DEFAULT "tgz"', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE backups DROP COLUMN format', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
