'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps CHANGE lastBackupId restoreConfigJson TEXT', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps CHANGE restoreConfigJson lastBackupId TEXT', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
