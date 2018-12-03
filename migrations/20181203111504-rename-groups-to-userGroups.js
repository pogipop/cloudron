'use strict';

exports.up = function(db, callback) {
    db.runSql('SELECT 1 FROM groups LIMIT 1', function (error) {
        if (error) return callback(); // groups table does not exist

        db.runSql('RENAME TABLE groups TO userGroups', function (error) {
            if (error) console.error(error);
            callback(error);
        });
    });
};

exports.down = function(db, callback) {
    // this is a one way renaming since the previous migration steps have been already updated to match the new name
    callback();
};
