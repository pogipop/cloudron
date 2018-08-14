'use strict';

exports.up = function(db, callback) {
    db.all('SELECT value FROM settings WHERE name="backup_config"', function (error, results) {
        if (error || results.length === 0) return callback(error);

        var backupConfig = JSON.parse(results[0].value);
        backupConfig.intervalSecs = 24 * 60 * 60;
        db.runSql('UPDATE settings SET value=? WHERE name="backup_config"', [ JSON.stringify(backupConfig) ], callback);

    });
};

exports.down = function(db, callback) {
  callback();
};
