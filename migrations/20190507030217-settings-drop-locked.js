'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE settings DROP COLUMN locked', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE settings ADD COLUMN locked BOOLEAN DEFAULT 0', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
