'use strict';

var async = require('async');

exports.up = function(db, callback) {
    db.all('SELECT * FROM users', [ ], function (error, users) {
        if (error) return callback(error);

        db.all('SELECT * FROM mail WHERE enabled=1', [ ], function (error, mailDomains) {
            if (error) return callback(error);

            async.series([
                db.runSql.bind(db, 'START TRANSACTION;'),
                db.runSql.bind(db, 'ALTER TABLE users DROP INDEX users_email'),
                db.runSql.bind(db, 'ALTER TABLE users ADD COLUMN fallbackEmail VARCHAR(512) DEFAULT ""'),
                function setDefaults(done) {
                    async.eachSeries(users, function (user, iteratorCallback) {
                        var defaultEmail = '';
                        var fallbackEmail = '';

                        if (mailDomains.length === 0) {
                            defaultEmail = user.email;
                            fallbackEmail = user.email;
                        } else {
                            defaultEmail = user.username ? (user.username + '@' + mailDomains[0].domain) : user.email;
                            fallbackEmail = user.email;
                        }

                        db.runSql('UPDATE users SET email = ?, fallbackEmail = ? WHERE id = ?', [ defaultEmail, fallbackEmail, user.id ], iteratorCallback);
                    }, done);
                },
                db.runSql.bind(db, 'ALTER TABLE users ADD UNIQUE users_email (email)'),
                db.runSql.bind(db, 'COMMIT')
            ], callback);
        });
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE users DROP COLUMN fallbackEmail', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
