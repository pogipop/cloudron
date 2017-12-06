'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps ADD COLUMN updateTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP COLUMN updateTime', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
