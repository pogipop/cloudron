'use strict';

exports.up = function(db, callback) {
    db.runSql('UPDATE clients SET scope=? WHERE id=?', ['*', 'cid-webadmin'], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    callback();
};
