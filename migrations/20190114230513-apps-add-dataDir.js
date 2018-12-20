'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps ADD COLUMN dataDir VARCHAR(256) UNIQUE', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP COLUMN dataDir', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
