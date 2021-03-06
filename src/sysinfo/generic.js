'use strict';

exports = module.exports = {
    getPublicIp: getPublicIp
};

var assert = require('assert'),
    async = require('async'),
    superagent = require('superagent'),
    SysInfoError = require('../sysinfo.js').SysInfoError;

function getPublicIp(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (process.env.BOX_ENV === 'test') return callback(null, '127.0.0.1');

    async.retry({ times: 10, interval: 5000 }, function (callback) {
        superagent.get('https://api.cloudron.io/api/v1/helper/public_ip').timeout(30 * 1000).end(function (error, result) {
            if (error || result.statusCode !== 200) {
                console.error('Error getting IP', error);
                return callback(new SysInfoError(SysInfoError.EXTERNAL_ERROR, 'Unable to detect IP. API server unreachable'));
            }
            if (!result.body && !result.body.ip) {
                console.error('Unexpected answer. No "ip" found in response body.', result.body);
                return callback(new SysInfoError(SysInfoError.EXTERNAL_ERROR, 'Unable to detect IP. No IP found in response'));
            }

            callback(null, result.body.ip);
        });
    }, function (error, result) {
        if (error) return callback(error);

        callback(null, result);
    });
}
