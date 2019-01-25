'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE domains ADD COLUMN locked BOOLEAN DEFAULT 0', function (error) {
        if (error) return callback(error);

        callback();
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE domains DROP COLUMN locked', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

