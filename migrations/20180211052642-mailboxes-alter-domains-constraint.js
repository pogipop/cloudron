'use strict';

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),
        db.runSql.bind(db, 'ALTER TABLE mailboxes DROP FOREIGN KEY mailboxes_domain_constraint'),
        db.runSql.bind(db, 'ALTER TABLE mailboxes ADD CONSTRAINT mailboxes_domain_constraint FOREIGN KEY(domain) REFERENCES mail(domain)'),
        db.runSql.bind(db, 'COMMIT')
    ], callback);
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE mailboxes DROP FOREIGN KEY mailboxes_domain_constraint', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
