'use strict';

var async = require('async');

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE users ADD COLUMN admin BOOLEAN DEFAULT 0', function (error) {
        if (error) return callback(error);

        db.all('SELECT userId FROM groupMembers WHERE groupId=?', [ 'admin' ], function (error, results) {
            if (error) return callback(error);

            if (results.length === 0) return callback();

            async.eachSeries(results, function (result, iteratorDone) {
                db.runSql('UPDATE users SET admin=1 WHERE id=?', [ result.userId ], iteratorDone);
            }, function (error) {
                if (error) return callback(error);

                async.series([
                    db.runSql.bind(db, 'DELETE FROM groupMembers WHERE groupId=?', [ 'admin' ]),
                    db.runSql.bind(db, 'DELETE FROM groups WHERE id=?', [ 'admin' ])
                ], callback);
            });
        });
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE users DROP COLUMN admin', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

