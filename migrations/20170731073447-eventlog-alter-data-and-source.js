'use strict';

// we used to have JSON as the db type for those two, however mariadb does not support it
// and we never used any JSON related features, but have the TEXT pattern everywhere
// This ensures all old cloudrons will have the columns altered

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE eventlog MODIFY data TEXT', [], function (error) {
        if (error) console.error(error);

        db.runSql('ALTER TABLE eventlog MODIFY source TEXT', [], function (error) {
            if (error) console.error(error);

            callback(error);
        });
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE eventlog MODIFY data TEXT', [], function (error) {
        if (error) console.error(error);

        db.runSql('ALTER TABLE eventlog MODIFY source TEXT', [], function (error) {
            if (error) console.error(error);

            callback(error);
        });
    });
};
