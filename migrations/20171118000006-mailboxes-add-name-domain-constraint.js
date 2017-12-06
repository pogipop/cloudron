'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE mailboxes ADD UNIQUE mailboxes_name_domain_unique_index (name, domain)', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE mailboxes DROP INDEX mailboxes_name_domain_unique_index', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
