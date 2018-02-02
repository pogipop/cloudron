'use strict';

var async = require('async'),
    fs = require('fs'),
    superagent = require('superagent');

exports.up = function(db, callback) {
    if (!fs.existsSync('/home/yellowtent/configs/cloudron.conf')) {
        console.log('Unable to locate cloudron.conf');
        return callback();
    }

    var config = JSON.parse(fs.readFileSync('/home/yellowtent/configs/cloudron.conf', 'utf8'));

    if (config.provider !== 'caas' || !config.fqdn) {
        console.log('Not caas (%s) or no fqdn', config.provider, config.fqdn);
        return callback();
    }

    db.runSql('SELECT COUNT(*) AS total FROM users', function (error, result) {
        if (error) return callback(error);

        if (result[0].total === 0) {
            console.log('This cloudron is not activated. It will automatically get appstore and caas configs from autoprovision logic');
            return callback();
        }

        console.log('Downloading appstore and caas config');

        superagent.get(config.apiServerOrigin + `/api/v1/boxes/${config.fqdn}/config`)
            .query({ token: config.token })
            .timeout(30 * 1000).end(function (error, result) {
                if (error) return callback(error);

                console.log('Adding %j config', result.body);

                async.eachSeries([
                    db.runSql.bind(db, 'INSERT settings (name, value) VALUES(?, ?)', [ 'appstore_config', JSON.stringify(result.body.appstoreConfig) ]),
                    db.runSql.bind(db, 'INSERT settings (name, value) VALUES(?, ?)', [ 'caas_config', JSON.stringify(result.body.caasConfig) ])
                ], callback);
            });
    });
};

exports.down = function(db, callback) {
    callback();
};
