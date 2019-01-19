'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE tasks CHANGE result resultJson TEXT', [], function (error) {
        if (error) console.error(error);

        db.runSql('DELETE FROM tasks', callback); // empty tasks table since we have bad results format
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE tasks CHANGE resultJson result TEXT', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
