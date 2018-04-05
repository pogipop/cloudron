'use strict';

var async = require('async');

exports.up = function(db, callback) {
    var users = { }, groupMembers = { };

    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),
        db.runSql.bind(db, 'ALTER TABLE mailboxes ADD COLUMN membersJson TEXT'),
        function getUsers(done) {
            db.all('SELECT * from users', [ ], function (error, results) {
                if (error) return done(error);

                results.forEach(function (result) { users[result.id] = result; });

                done();
            });
        },
        function getGroups(done) {
            db.all('SELECT id, name, GROUP_CONCAT(groupMembers.userId) AS userIds ' +
                ' FROM groups LEFT OUTER JOIN groupMembers ON groups.id = groupMembers.groupId ' +
                ' GROUP BY groups.id', [ ], function (error, results) {
                if (error) return done(error);

                results.forEach(function (result) {
                    var userIds = result.userIds ? result.userIds.split(',') : [ ];
                    var members = userIds.map(function (id) { return users[id].name; });
                    groupMembers[result.id] = members;
                });

                done();
            });
        },
        function removeGroupIdAndSetMembers(done) {
            async.eachSeries(Object.keys(groupMembers), function (gid, iteratorDone) {
                console.log(`Migrating group id ${gid} to ${JSON.stringify(groupMembers[gid])}`);

                db.runSql('UPDATE mailboxes SET membersJson = ? AND ownerId = ? WHERE ownerId = ?', [ JSON.stringify(groupMembers[gid]), 'admin', gid ], iteratorDone);
            }, done);
        },
        db.runSql.bind(db, 'COMMIT')
    ], callback);
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE mailboxes DROP COLUMN membersJson', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
