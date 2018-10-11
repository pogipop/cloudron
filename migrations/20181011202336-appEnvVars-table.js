'use strict';

exports.up = function(db, callback) {
    var cmd = 'CREATE TABLE IF NOT EXISTS appEnvVars(' +
                'appId VARCHAR(128) NOT NULL,' +
                'name TEXT NOT NULL,' +
                'value TEXT NOT NULL,' +
                'FOREIGN KEY(appId) REFERENCES apps(id)) CHARACTER SET utf8 COLLATE utf8_bin';

    db.runSql(cmd, function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('DROP TABLE appEnvVars', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
