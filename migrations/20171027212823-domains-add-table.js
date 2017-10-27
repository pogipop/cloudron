'use strict';

exports.up = function(db, callback) {
    var cmd = "CREATE TABLE domains(" +
            "domain VARCHAR(128) NOT NULL," +
            "zoneName VARCHAR(128) NOT NULL," +
            "configJson TEXT," +
            "PRIMARY KEY (domain))";

    db.runSql(cmd, function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('DROP TABLE domains', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
