'use strict';

exports.up = function(db, callback) {
    var cmd = 'CREATE TABLE notifications(' +
        'id int NOT NULL AUTO_INCREMENT,' +
        'userId VARCHAR(128) NOT NULL,' +
        'eventId VARCHAR(128) NOT NULL,' +
        'title VARCHAR(512) NOT NULL,' +
        'message TEXT,' +
        'action VARCHAR(512) NOT NULL,' +
        'acknowledged BOOLEAN DEFAULT false,' +
        'creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
        'FOREIGN KEY(eventId) REFERENCES eventlog(id),' +
        'PRIMARY KEY (id)) CHARACTER SET utf8 COLLATE utf8_bin';

    db.runSql(cmd, function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('DROP TABLE notifications', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
