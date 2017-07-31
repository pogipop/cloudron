'use strict';

exports.up = function(db, callback) {
    var cmd = "CREATE TABLE eventlog(" +
            "id VARCHAR(128) NOT NULL," +
            "source TEXT," +
            "creationTime TIMESTAMP," +
            "action VARCHAR(128) NOT NULL," +
            "data TEXT," +
            "PRIMARY KEY (id))";

    db.runSql(cmd, function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('DROP TABLE eventlog', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
