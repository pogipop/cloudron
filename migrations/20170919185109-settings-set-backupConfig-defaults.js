'use strict';

// ensure backupFolder and format are not empty
exports.up = function(db, callback) {
    db.all('SELECT * FROM settings WHERE name=?', [ 'backup_config' ], function (error, result) {
        if (error || result.length === 0) return callback(error);

        var value = JSON.parse(result[0].value);
        value.format = 'tgz'; // set the format

        if (value.provider === 'filesystem' && !value.backupFolder) {
            value.backupFolder = '/var/backups'; // set the backupFolder
        }

        db.runSql('UPDATE settings SET value = ? WHERE name = ?', [ JSON.stringify(value), 'backup_config' ], function (error) {
            if (error) console.error('Error setting ownerid ' + JSON.stringify(u) + error);
            callback();
        });

    });
};

exports.down = function(db, callback) {
    callback();
};
