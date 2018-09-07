'use strict';

var async = require('async');

exports.up = function(db, callback) {
    db.all('SELECT * from domains WHERE provider=?', [ 'manual' ], function (error, results) {
        if (error) return callback(error);

        async.eachSeries(results, function (result, iteratorDone) {
            var config = JSON.parse(result.configJson || '{}');
            if (!config.wildcard) return iteratorDone();
            delete config.wildcard;

            db.runSql('UPDATE domains SET provider=?, configJson=? WHERE domain=?', [ 'wildcard', JSON.stringify(config), result.domain ], iteratorDone);
        }, callback);
    });
};

exports.down = function(db, callback) {
    callback();
};
