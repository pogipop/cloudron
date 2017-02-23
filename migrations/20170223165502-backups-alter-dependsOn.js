'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE backups MODIFY dependsOn TEXT', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE backups MODIFY dependsOn VARCHAR(4096)', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
