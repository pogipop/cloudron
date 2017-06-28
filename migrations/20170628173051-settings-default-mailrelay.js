'use strict';

exports.up = function(db, callback) {
    db.runSql('INSERT settings (name, value) VALUES("mail_relay", ?)', [ JSON.stringify({ provider: 'cloudron-smtp' }) ], callback);
};

exports.down = function(db, callback) {
    db.runSql('DELETE * FROM settings WHERE name="mail_relay"', [ ], callback);
};
