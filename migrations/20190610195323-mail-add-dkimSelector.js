'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE mail ADD COLUMN dkimSelector VARCHAR(128) NOT NULL DEFAULT "cloudron"', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE mail DROP COLUMN dkimSelector', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
