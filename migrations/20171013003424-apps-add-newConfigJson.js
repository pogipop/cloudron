'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps ADD COLUMN newConfigJson TEXT', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP COLUMN newConfigJson', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
