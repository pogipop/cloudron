'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE apps CHANGE createdAt creationTime TIMESTAMP(2) NOT NULL', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE apps CHANGE creationTime createdAt TIMESTAMP(2) NOT NULL', [], function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
