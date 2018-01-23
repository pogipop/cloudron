'use strict';

exports.up = function(db, callback) {
    var cmd = 'CREATE TABLE IF NOT EXISTS mail(' +
                'domain VARCHAR(128) NOT NULL UNIQUE,' +
                'enabled BOOLEAN DEFAULT 0,' +
                'mailFromValidation BOOLEAN DEFAULT 1,' +
                'catchAllJson TEXT,' +
                'relayJson TEXT,' +
                'FOREIGN KEY(domain) REFERENCES domains(domain),' +
                'PRIMARY KEY(domain)) CHARACTER SET utf8 COLLATE utf8_bin';

    db.runSql(cmd, function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('DROP TABLE mail', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
