#!/usr/bin/env node

'use strict';

// prefix all output with a timestamp
// debug() already prefixes and uses process.stderr NOT console.*
['log', 'info', 'warn', 'debug', 'error'].forEach(function (log) {
    var orig = console[log];
    console[log] = function () {
        orig.apply(console, [new Date().toISOString()].concat(Array.prototype.slice.call(arguments)));
    };
});

require('supererror')({ splatchError: true });

let async = require('async'),
    config = require('./src/config.js'),
    constants = require('./constants.js'),
    ldap = require('./src/ldap.js'),
    dockerProxy = require('./src/dockerproxy.js'),
    server = require('./src/server.js');

console.log();
console.log('==========================================');
console.log(' Cloudron will use the following settings ');
console.log('==========================================');
console.log();
console.log(' Environment:                    ', config.CLOUDRON ? 'CLOUDRON' : 'TEST');
console.log(' Version:                        ', constants.VERSION);
console.log(' Admin Origin:                   ', config.adminOrigin());
console.log(' Appstore API server origin:     ', config.apiServerOrigin());
console.log(' Appstore Web server origin:     ', config.webServerOrigin());
console.log(' SysAdmin Port:                  ', config.get('sysadminPort'));
console.log(' LDAP Server Port:               ', config.get('ldapPort'));
console.log(' Docker Proxy Port:              ', config.get('dockerProxyPort'));
console.log();
console.log('==========================================');
console.log();

async.series([
    server.start,
    ldap.start,
    dockerProxy.start
], function (error) {
    if (error) {
        console.error('Error starting server', error);
        process.exit(1);
    }
    console.log('Cloudron is up and running');
});

var NOOP_CALLBACK = function () { };

process.on('SIGINT', function () {
    console.log('Received SIGINT. Shutting down.');

    server.stop(NOOP_CALLBACK);
    ldap.stop(NOOP_CALLBACK);
    dockerProxy.stop(NOOP_CALLBACK);
    setTimeout(process.exit.bind(process), 3000);
});

process.on('SIGTERM', function () {
    console.log('Received SIGTERM. Shutting down.');

    server.stop(NOOP_CALLBACK);
    ldap.stop(NOOP_CALLBACK);
    dockerProxy.stop(NOOP_CALLBACK);
    setTimeout(process.exit.bind(process), 3000);
});
