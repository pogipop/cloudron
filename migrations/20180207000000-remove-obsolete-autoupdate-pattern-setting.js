'use strict';

exports.up = function(db, callback) {
    db.runSql('DELETE FROM settings WHERE name=?', ['autoupdate_pattern'], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    callback();
};
