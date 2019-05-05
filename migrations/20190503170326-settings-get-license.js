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

    db.all('SELECT * FROM settings WHERE name="appstore_config"', function (error, results) {
        if (error) return callback(error);

        if (results.length === 0) {
            console.log('No appstore config, skipping license migration');
            return callback();
        }

        console.log('Downloading license');

        superagent.get(`${config.apiServerOrigin}/api/v1/cloudron_license`)
            .query({ accessToken: config.token })
            .timeout(30 * 1000).end(function (error, result) {
                if (error && !error.response) return callback(new Error('Network error getting license:' + error.message));
                if (result.statusCode !== 200) return callback(new Error(`Bad status getting license: ${result.status} ${result.text}`));

                if (!result.body.cloudronId || !result.body.licenseKey || !result.body.cloudronToken) return callback(new Error(`Bad response getting license:  ${result.text}`));

                console.log('Adding license', result.body);

                async.series([
                    db.runSql.bind(db, 'START TRANSACTION;'),
                    db.runSql.bind(db, 'INSERT settings (name, value) VALUES(?, ?)', [ 'cloudron_id', JSON.stringify(result.body.cloudronId) ]),
                    db.runSql.bind(db, 'INSERT settings (name, value) VALUES(?, ?)', [ 'license_key', JSON.stringify(result.body.licenseKey) ]),
                    db.runSql.bind(db, 'INSERT settings (name, value) VALUES(?, ?)', [ 'cloudron_token', JSON.stringify(result.body.cloudronToken) ]),
                    db.runSql.bind(db, 'DELETE FROM settings WHERE name=?', [ 'appstore_config' ]),
                    db.runSql.bind(db, 'COMMIT')
                ], callback);
            });
    });
};

exports.down = function(db, callback) {
    callback();
};
