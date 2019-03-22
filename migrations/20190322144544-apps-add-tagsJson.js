'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps ADD COLUMN tagsJson VARCHAR(2048)', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP COLUMN tagsJson ', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
