'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE mailboxes DROP PRIMARY KEY', function (error) {
      if (error) console.error(error);
      callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE mailboxes ADD PRIMARY KEY(name)', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
