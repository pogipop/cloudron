'use strict';

exports = module.exports = {
    sync: sync
};

var appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    async = require('async'),
    config = require('./config.js'),
    debug = require('debug')('box:dyndns'),
    domains = require('./domains.js'),
    sysinfo = require('./sysinfo.js');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

// called for dynamic dns setups where we have to update the IP
function sync(callback) {
    callback = callback || NOOP_CALLBACK;

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(error);

        debug('refreshDNS: current ip %s', ip);

        domains.upsertDnsRecords(config.adminLocation(), config.adminDomain(), 'A', [ ip ], function (error) {
            if (error) return callback(error);

            debug('refreshDNS: done for admin location');

            apps.getAll(function (error, result) {
                if (error) return callback(error);

                async.each(result, function (app, callback) {
                    // do not change state of installing apps since apptask will error if dns record already exists
                    if (app.installationState !== appdb.ISTATE_INSTALLED) return callback();

                    domains.upsertDnsRecords(app.location, app.domain, 'A', [ ip ], callback);
                }, function (error) {
                    if (error) return callback(error);

                    debug('refreshDNS: done for apps');

                    callback();
                });
            });
        });
    });
}
