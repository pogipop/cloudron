'use strict';

var async = require('async'),
    fs = require('fs'),
    superagent = require('superagent');

exports.up = function(db, callback) {
    if (!fs.existsSync('/etc/cloudron/cloudron.conf')) {
        console.log('Unable to locate cloudron.conf');
        return callback();
    }

    const config = JSON.parse(fs.readFileSync('/etc/cloudron/cloudron.conf', 'utf8'));

    async.series([
        db.runSql.bind(db, 'START TRANSACTION;'),
        db.runSql.bind(db, 'INSERT settings (name, value) VALUES(?, ?)', [ 'api_server_origin', config.apiServerOrigin ]),
        db.runSql.bind(db, 'INSERT settings (name, value) VALUES(?, ?)', [ 'web_server_origin', config.webServerOrigin ]),
        db.runSql.bind(db, 'INSERT settings (name, value) VALUES(?, ?)', [ 'admin_domain', config.adminDomain ]),
        db.runSql.bind(db, 'INSERT settings (name, value) VALUES(?, ?)', [ 'admin_fqdn', config.adminFqdn ]),
        db.runSql.bind(db, 'INSERT settings (name, value) VALUES(?, ?)', [ 'demo', config.isDemo ]),
        db.runSql.bind(db, 'COMMIT')
    ], callback);
};

exports.down = function(db, callback) {
    callback();
};
