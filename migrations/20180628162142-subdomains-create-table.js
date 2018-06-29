'use strict';

exports.up = function(db, callback) {
    var cmd = 'CREATE TABLE IF NOT EXISTS subdomains(' +
                'appId VARCHAR(128) NOT NULL,' +
                'domain VARCHAR(128) NOT NULL,' +
                'subdomain VARCHAR(128) NOT NULL,' +
                'type VARCHAR(128) NOT NULL,' +
                'dnsRecordId VARCHAR(512),' +
                'FOREIGN KEY(domain) REFERENCES domains(domain),' +
                'FOREIGN KEY(appId) REFERENCES apps(id),' +
                'UNIQUE (subdomain, domain)) CHARACTER SET utf8 COLLATE utf8_bin';

    db.runSql(cmd, function (error) {
        if (error) console.error(error);
        callback(error);
    });
};

exports.down = function(db, callback) {
    db.runSql('DROP TABLE subdomains', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
