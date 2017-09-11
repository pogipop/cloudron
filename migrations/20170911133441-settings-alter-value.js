'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE settings MODIFY value TEXT', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE settings MODIFY value VARCHAR(512)', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
