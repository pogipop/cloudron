'use strict';

exports.up = function(db, callback) {
    db.all('SELECT value FROM settings WHERE name="backup_config"', function (error, results) {
        if (error || results.length === 0) return callback(error);

        var backupConfig = JSON.parse(results[0].value);
        if (backupConfig.provider !== 'caas') return callback();

        backupConfig.boxId = backupConfig.prefix; // hack to set the boxId that happens to match the prefix
        delete backupConfig.fqdn;

        db.runSql('UPDATE settings SET value=? WHERE name="backup_config"', [ JSON.stringify(backupConfig) ], callback);
    });
};

exports.down = function(db, callback) {
  callback();
};
