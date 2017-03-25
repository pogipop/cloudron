'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE appAddonConfigs ADD COLUMN name VARCHAR(128)', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE appAddonConfigs DROP COLUMN name', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

