'use strict';

exports.up = function(db, callback) {
	var cmd = "CREATE TABLE IF NOT EXISTS groupMembers(" +
    			"groupId VARCHAR(128) NOT NULL," +
    			"userId VARCHAR(128) NOT NULL," +
    			"FOREIGN KEY(groupId) REFERENCES userGroups(id)," +
    			"FOREIGN KEY(userId) REFERENCES users(id));";

    db.runSql(cmd, function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('DROP TABLE groupMembers', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
