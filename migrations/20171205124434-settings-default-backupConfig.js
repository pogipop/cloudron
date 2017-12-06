'use strict';

exports.up = function(db, callback) {
    var backupConfig = {
        "provider": "filesystem",
        "backupFolder": "/var/backups",
        "format": "tgz",
        "retentionSecs": 172800
    };

    db.runSql('INSERT settings (name, value) VALUES(?, ?)', [ 'backup_config', JSON.stringify(backupConfig) ], function (error) {
        if (!error || error.code === 'ER_DUP_ENTRY') return callback(); // dup entry is OK for existing cloudrons

        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('DELETE FROM settings WHERE name=?', ['backup_config'], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
