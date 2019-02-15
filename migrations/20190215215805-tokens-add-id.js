'use strict';

var async = require('async');
var uuid = require('uuid');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),

        db.runSql.bind(db, 'ALTER TABLE tokens ADD COLUMN id VARCHAR(128)'),

        function (done) {
            db.runSql('SELECT * FROM tokens', function (error, tokens) {
                async.eachSeries(tokens, function (token, iteratorDone) {
                    db.runSql('UPDATE tokens SET id=? WHERE accessToken=?', [ 'tid-'+uuid.v4(), token.accessToken ], iteratorDone);
                }, done);
            });
        },

        db.runSql.bind(db, 'ALTER TABLE tokens MODIFY id VARCHAR(128) NOT NULL UNIQUE'),
        db.runSql.bind(db, 'COMMIT'),
    ], callback);
};

exports.down = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'ALTER TABLE tokens DROP COLUMN id'),
    ], callback);
};
