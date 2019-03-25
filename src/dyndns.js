'use strict';

exports = module.exports = {
    sync: sync
};

var appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    debug = require('debug')('box:dyndns'),
    domains = require('./domains.js'),
    eventlog = require('./eventlog.js'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    sysinfo = require('./sysinfo.js');

// called for dynamic dns setups where we have to update the IP
function sync(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(error);

        let info = safe.JSON.parse(safe.fs.readFileSync(paths.DYNDNS_INFO_FILE, 'utf8')) || { ip: null };
        if (info.ip === ip) {
            debug(`refreshDNS: no change in IP ${ip}`);
            return callback();
        }

        debug(`refreshDNS: updating ip from ${info.ip} to ${ip}`);

        domains.upsertDnsRecords(constants.ADMIN_LOCATION, config.adminDomain(), 'A', [ ip ], function (error) {
            if (error) return callback(error);

            debug('refreshDNS: updated admin location');

            apps.getAll(function (error, result) {
                if (error) return callback(error);

                async.each(result, function (app, callback) {
                    // do not change state of installing apps since apptask will error if dns record already exists
                    if (app.installationState !== appdb.ISTATE_INSTALLED) return callback();

                    domains.upsertDnsRecords(app.location, app.domain, 'A', [ ip ], callback);
                }, function (error) {
                    if (error) return callback(error);

                    debug('refreshDNS: updated apps');

                    eventlog.add(eventlog.ACTION_DYNDNS_UPDATE, auditSource, { fromIp: info.ip, toIp: ip });
                    info.ip = ip;
                    safe.fs.writeFileSync(paths.DYNDNS_INFO_FILE, JSON.stringify(info), 'utf8');

                    callback();
                });
            });
        });
    });
}
