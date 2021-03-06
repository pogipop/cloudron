'use strict';

var async = require('async');

exports.up = function(db, callback) {
    db.all('SELECT * FROM settings WHERE name = ?', [ 'tls_config' ], function (error, result) {
        if (error) return callback(error);

        var tlsConfig = (result[0] && result[0].value) ? JSON.parse(result[0].value) : { provider: 'letsencrypt-prod'};
        tlsConfig.provider = tlsConfig.provider.replace(/$le\-/, 'letsencrypt-'); // old cloudrons had le-prod/le-staging

        async.series([
            db.runSql.bind(db, 'START TRANSACTION;'),
            db.runSql.bind(db, 'ALTER TABLE domains ADD COLUMN tlsConfigJson TEXT'),
            db.runSql.bind(db, 'UPDATE domains SET tlsConfigJson = ?', [ JSON.stringify(tlsConfig) ]),
            db.runSql.bind(db, 'COMMIT')
        ], callback);
    });
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE domains DROP COLUMN tlsConfigJson', function (error) {
        if (error) console.error(error);
        callback(error);
    });
};
