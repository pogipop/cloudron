'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps CHANGE newConfigJson updateConfigJson TEXT', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps CHANGE updateConfigJson newConfigJson TEXT', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
