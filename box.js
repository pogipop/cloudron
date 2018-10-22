#!/usr/bin/env node

'use strict';

require('supererror')({ splatchError: true });

// remove timestamp from debug() based output
require('debug').formatArgs = function formatArgs(args) {
    args[0] = this.namespace + ' ' + args[0];
};

let async = require('async'),
    config = require('./src/config.js'),
    ldap = require('./src/ldap.js'),
    dockerProxy = require('./src/dockerproxy.js'),
    server = require('./src/server.js');

console.log();
console.log('==========================================');
console.log(' Cloudron will use the following settings ');
console.log('==========================================');
console.log();
console.log(' Environment:                    ', config.CLOUDRON ? 'CLOUDRON' : 'TEST');
console.log(' Version:                        ', config.version());
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
    server.stop(NOOP_CALLBACK);
    ldap.stop(NOOP_CALLBACK);
    dockerProxy.stop(NOOP_CALLBACK);
    setTimeout(process.exit.bind(process), 3000);
});

process.on('SIGTERM', function () {
    server.stop(NOOP_CALLBACK);
    ldap.stop(NOOP_CALLBACK);
    dockerProxy.stop(NOOP_CALLBACK);
    setTimeout(process.exit.bind(process), 3000);
});
