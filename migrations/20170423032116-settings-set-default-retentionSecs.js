'use strict';

exports.up = function(db, callback) {
    db.all('SELECT value FROM settings WHERE name="backup_config"', function (error, results) {
        if (error || results.length === 0) return callback(error);

        var backupConfig = JSON.parse(results[0].value);
        if (backupConfig.provider === 'filesystem') {
            backupConfig.retentionSecs = 2 * 24 * 60 * 60; // 2 days
        } else if (backupConfig.provider === 's3') { // S3
            backupConfig.retentionSecs = -1;
        } else if (backupConfig.provider === 'caas') {
            backupConfig.retentionSecs = 10 * 24 * 60 * 60; // 10 days
        }
        db.runSql('UPDATE settings SET value=? WHERE name="backup_config"', [ JSON.stringify(backupConfig) ], callback);

    });
};

exports.down = function(db, callback) {
  callback();
};
