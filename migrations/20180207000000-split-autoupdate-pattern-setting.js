'use strict';

var async = require('async');

exports.up = function(db, callback) {
    db.runSql('SELECT * FROM settings WHERE name=?', ['autoupdate_pattern'], function (error, results) {
        if (error || results.length === 0) return callback(error); // will use defaults from box code

        // migrate the 'daily' update pattern
        var appUpdatePattern = results[0].value;
        if (appUpdatePattern === '00 00 1,3,5,23 * * *') appUpdatePattern = '00 30 1,3,5,23 * * *';

        async.series([
            db.runSql.bind(db, 'START TRANSACTION;'),
            db.runSql.bind(db, 'DELETE FROM settings WHERE name=?', ['autoupdate_pattern']),
            db.runSql.bind(db, 'INSERT settings (name, value) VALUES(?, ?)', ['app_autoupdate_pattern', appUpdatePattern]),
            db.runSql.bind(db, 'COMMIT')
        ], callback);
    });
};

exports.down = function(db, callback) {
    callback();
};
