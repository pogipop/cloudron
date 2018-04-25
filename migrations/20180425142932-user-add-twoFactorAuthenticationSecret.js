'use strict';

exports.up = function(db, callback) {
    db.runSql('ALTER TABLE users ADD COLUMN twoFactorAuthenticationSecret VARCHAR(128) DEFAULT "", ADD COLUMN twoFactorAuthenticationEnabled BOOLEAN DEFAULT false', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE users DROP twoFactorAuthenticationSecret, DROP twoFactorAuthenticationEnabled', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
