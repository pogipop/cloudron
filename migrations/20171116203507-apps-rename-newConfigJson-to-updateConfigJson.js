'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps CHANGE newConfigJson updateConfigJson VARCHAR(2048)', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps CHANGE newConfigJson updateConfigJson VARCHAR(2048)', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
