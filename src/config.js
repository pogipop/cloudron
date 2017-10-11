'use strict';

exports = module.exports = {
    baseDir: baseDir,

    // values set here will be lost after a upgrade/update. use the sqlite database
    // for persistent values that need to be backed up
    get: get,
    set: set,

    // ifdefs to check environment
    CLOUDRON: process.env.BOX_ENV === 'cloudron',
    TEST: process.env.BOX_ENV === 'test',

    // convenience getters
    provider: provider,
    apiServerOrigin: apiServerOrigin,
    webServerOrigin: webServerOrigin,
    fqdn: fqdn,
    setFqdn: setFqdn,
    token: token,
    version: version,
    setVersion: setVersion,
    isCustomDomain: isCustomDomain,
    database: database,

    // these values are derived
    adminOrigin: adminOrigin,
    internalAdminOrigin: internalAdminOrigin,
    sysadminOrigin: sysadminOrigin, // caas routes
    adminFqdn: adminFqdn,
    mailFqdn: mailFqdn,
    appFqdn: appFqdn,
    zoneName: zoneName,
    setZoneName: setZoneName,
    hasIPv6: hasIPv6,

    isDemo: isDemo,

    tlsCert: tlsCert,
    tlsKey: tlsKey,

    // for testing resets to defaults
    _reset: _reset
};

var assert = require('assert'),
    constants = require('./constants.js'),
    fs = require('fs'),
    path = require('path'),
    safe = require('safetydance'),
    tld = require('tldjs'),
    _ = require('underscore');

var homeDir = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;

var data = { };

function baseDir() {
    if (exports.CLOUDRON) return homeDir;
    if (exports.TEST) return path.join(homeDir, '.cloudron_test');
}

var cloudronConfigFileName = path.join(baseDir(), 'configs/cloudron.conf');

function saveSync() {
    fs.writeFileSync(cloudronConfigFileName, JSON.stringify(data, null, 4)); // functions are ignored by JSON.stringify
}

function _reset(callback) {
    safe.fs.unlinkSync(cloudronConfigFileName);

    initConfig();

    if (callback) callback();
}

function initConfig() {
    // setup defaults
    data.fqdn = 'localhost';
    data.zoneName = '';

    data.token = null;
    data.version = null;
    data.isCustomDomain = true;
    data.webServerOrigin = null;
    data.smtpPort = 2525; // // this value comes from mail container
    data.sysadminPort = 3001;
    data.ldapPort = 3002;
    data.provider = 'caas';
    data.appBundle = [ ];

    if (exports.CLOUDRON) {
        data.port = 3000;
        data.apiServerOrigin = null;
        data.database = null;
    } else if (exports.TEST) {
        data.port = 5454;
        data.apiServerOrigin = 'http://localhost:6060'; // hock doesn't support https
        data.database = {
            hostname: '127.0.0.1',
            username: 'root',
            password: '',
            port: 3306,
            name: 'boxtest'
        };
        data.token = 'APPSTORE_TOKEN';
    } else {
        assert(false, 'Unknown environment. This should not happen!');
    }

    if (safe.fs.existsSync(cloudronConfigFileName)) {
        var existingData = safe.JSON.parse(safe.fs.readFileSync(cloudronConfigFileName, 'utf8'));
        _.extend(data, existingData); // overwrite defaults with saved config
        return;
    }

    saveSync();
}

initConfig();

// set(obj) or set(key, value)
function set(key, value) {
    if (typeof key === 'object') {
        var obj = key;
        for (var k in obj) {
            assert(k in data, 'config.js is missing key "' + k + '"');
            data[k] = obj[k];
        }
    } else {
        data = safe.set(data, key, value);
    }
    saveSync();
}

function get(key) {
    assert.strictEqual(typeof key, 'string');

    return safe.query(data, key);
}

function apiServerOrigin() {
    return get('apiServerOrigin');
}

function webServerOrigin() {
    return get('webServerOrigin');
}

function setFqdn(fqdn) {
    set('fqdn', fqdn);
}

function fqdn() {
    return get('fqdn');
}

function setZoneName(zone) {
    set('zoneName', zone);
}

function zoneName() {
    var zone = get('zoneName');
    if (zone) return zone;

    // TODO: move this to migration code path instead
    return tld.getDomain(fqdn()) || '';
}

// keep this in sync with start.sh admin.conf generation code
function appFqdn(location) {
    assert.strictEqual(typeof location, 'string');

    if (location === '') return fqdn();
    return isCustomDomain() ? location + '.' + fqdn() : location + '-' + fqdn();
}

function adminFqdn() {
    return appFqdn(constants.ADMIN_LOCATION);
}

function mailFqdn() {
    return appFqdn(constants.MAIL_LOCATION);
}

function adminOrigin() {
    return 'https://' + appFqdn(constants.ADMIN_LOCATION);
}

function internalAdminOrigin() {
    return 'http://127.0.0.1:' + get('port');
}

function sysadminOrigin() {
    return 'http://127.0.0.1:' + get('sysadminPort');
}

function token() {
    return get('token');
}

function version() {
    return get('version');
}

function setVersion(version) {
    set('version', version);
}

function isCustomDomain() {
    return get('isCustomDomain');
}

function database() {
    return get('database');
}

function isDemo() {
    return get('isDemo') === true;
}

function provider() {
    return get('provider');
}

function tlsCert() {
    var certFile = path.join(baseDir(), 'configs/host.cert');
    return safe.fs.readFileSync(certFile, 'utf8');
}

function tlsKey() {
    var keyFile = path.join(baseDir(), 'configs/host.key');
    return safe.fs.readFileSync(keyFile, 'utf8');
}

function hasIPv6() {
    const IPV6_PROC_FILE = '/proc/net/if_inet6';
    return fs.existsSync(IPV6_PROC_FILE);
}