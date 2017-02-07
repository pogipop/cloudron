'use strict';

exports.up = function(db, callback) {
    db.runSql('DELETE FROM settings', [ ], callback);
};

exports.down = function(db, callback) {
    callback();
};
