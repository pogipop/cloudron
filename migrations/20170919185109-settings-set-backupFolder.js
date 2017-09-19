'use strict';

// ensure backupFolder has not empty
exports.up = function(db, callback) {
    db.all('SELECT * FROM settings WHERE name=?', [ 'backup_config' ], function (error, result) {
        if (error || result.length === 0) return callback(error);

        var value = JSON.parse(result[0].value);
        if (value.provider !== 'filesystem' || value.backupFolder) return callback();

        value.backupFolder = '/var/backups';

        db.runSql('UPDATE settings SET value = ? WHERE name = ?', [ JSON.stringify(value), 'backup_config' ], function (error) {
            if (error) console.error('Error setting ownerid ' + JSON.stringify(u) + error);
            callback();
        });

    });
};

exports.down = function(db, callback) {
    callback();
};
