'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE subdomains DROP COLUMN dnsRecordId', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE subdomains ADD COLUMN dnsRecordId VARCHAR(512)', function (error) {
        if (error) return callback(error);
        callback();
    });
};
