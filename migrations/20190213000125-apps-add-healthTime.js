'use strict';

exports.up = function(db, callback) {
    var cmd = 'ALTER TABLE apps ADD COLUMN healthTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP';

    db.runSql(cmd, function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps DROP COLUMN healthTime', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
