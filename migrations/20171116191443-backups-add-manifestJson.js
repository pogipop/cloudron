'use strict';

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'ALTER TABLE backups ADD COLUMN manifestJson TEXT'),

        db.runSql.bind(db, 'START TRANSACTION;'),

        // fill all the backups with restoreConfigs from current apps
        function addManifests(callback) {
            console.log('Importing manifests');

            db.all('SELECT * FROM backups WHERE type="app"', function (error, backups) {
                if (error) return callback(error);

                async.eachSeries(backups, function (backup, next) {
                    var m = backup.restoreConfigJson ? JSON.stringify(JSON.parse(backup.restoreConfigJson).manifest) : null;

                    db.runSql('UPDATE backups SET manifestJson=? WHERE id=?', [ m, backup.id ], next);
                });
            });

            callback();
        },

        db.runSql.bind(db, 'COMMIT'),

        // remove the restoreConfig
        db.runSql.bind(db, 'ALTER TABLE backups DROP COLUMN restoreConfigJson')
    ], callback);
};

exports.down = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'ALTER TABLE backups DROP COLUMN manifestJson'),
        db.runSql.bind(db, 'ALTER TABLE backups ADD COLUMN restoreConfigJson TEXT'),
    ], callback);
};

