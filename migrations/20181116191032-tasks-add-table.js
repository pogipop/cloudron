'use strict';

exports.up = function(db, callback) {
    var cmd = "CREATE TABLE tasks(" +
            "id VARCHAR(32) NOT NULL UNIQUE," +
            "argsJson TEXT," +
            "percent INTEGER DEFAULT 0," +
            "message TEXT," +
            "errorMessage TEXT," +
            "result TEXT," +
            "creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP," +
            "ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP," +
            "PRIMARY KEY (id))";

    db.runSql(cmd, function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('DROP TABLE tasks', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
