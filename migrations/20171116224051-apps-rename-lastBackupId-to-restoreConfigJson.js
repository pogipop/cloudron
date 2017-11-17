'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps CHANGE lastBackupId restoreConfigJson VARCHAR(256)', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps CHANGE restoreConfigJson lastBackupId VARCHAR(256)', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
