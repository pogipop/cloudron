'use strict';

// WARNING!!
// At this point the default db collation is utf8mb4_unicode_ci however we already have foreign key constraits
// already with tables on utf8_bin charset, so we cannot convert all tables here to utf8mb4 collation without
// a reimport from a sql dump, as foreign keys across different collations are not supported

var async = require('async');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'ALTER TABLE appPortBindings CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE apps CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE authcodes CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE backups CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE clients CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE eventlog CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE groupMembers CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE userGroups CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE mailboxes CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE migrations CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE settings CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE tokens CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin'),
        db.runSql.bind(db, 'ALTER TABLE users CONVERT TO CHARACTER SET utf8 COLLATE utf8_bin')
    ], callback);
};

exports.down = function(db, callback) {
    // nothing to be done here
    callback();
};
