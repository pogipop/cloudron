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
    zoneName: zoneName,
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
    adminLocation: adminLocation,
    adminFqdn: adminFqdn,
    mailLocation: mailLocation,
    mailFqdn: mailFqdn,
    appFqdn: appFqdn,
    setZoneName: setZoneName,
    hasIPv6: hasIPv6,
    dkimSelector: dkimSelector,

    isDemo: isDemo,

    // for testing resets to defaults
    _reset: _reset
};

var assert = require('assert'),
    fs = require('fs'),
    path = require('path'),
    safe = require('safetydance'),
    tld = require('tldjs'),
    _ = require('underscore');


// assert on unknown environment can't proceed
assert(exports.CLOUDRON || exports.TEST, 'Unknown environment. This should not happen!');

var homeDir = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;

var data = { };

function baseDir() {
    if (exports.CLOUDRON) return homeDir;
    if (exports.TEST) return path.join(homeDir, '.cloudron_test');
}

var cloudronConfigFileName = path.join(baseDir(), 'configs/cloudron.conf');

// only tests can run without a config file on disk, they use the defaults with runtime overrides
if (exports.CLOUDRON) assert(fs.existsSync(cloudronConfigFileName), 'No cloudron.conf found, cannot proceed');

function saveSync() {
    // only save values we want to have in the cloudron.conf, see start.sh
    var conf = {
        version: data.version,
        token: data.token,
        apiServerOrigin: data.apiServerOrigin,
        webServerOrigin: data.webServerOrigin,
        fqdn: data.fqdn,
        zoneName: data.zoneName,
        adminLocation: data.adminLocation,
        isCustomDomain: data.isCustomDomain,
        provider: data.provider,
        isDemo: data.isDemo
    };

    fs.writeFileSync(cloudronConfigFileName, JSON.stringify(conf, null, 4)); // functions are ignored by JSON.stringify
}

function _reset(callback) {
    safe.fs.unlinkSync(cloudronConfigFileName);

    initConfig();

    if (callback) callback();
}

function initConfig() {
    // setup defaults
    data.fqdn = '';
    data.zoneName = '';
    data.adminLocation = 'my';
    data.port = 3000;
    data.token = null;
    data.version = null;
    data.isCustomDomain = true;
    data.apiServerOrigin = null;
    data.webServerOrigin = null;
    data.provider = 'caas';
    data.smtpPort = 2525; // this value comes from mail container
    data.sysadminPort = 3001;
    data.ldapPort = 3002;

    // keep in sync with start.sh
    data.database = {
        hostname: '127.0.0.1',
        username: 'root',
        password: 'password',
        port: 3306,
        name: 'box'
    };

    // overrides for local testings
    if (exports.TEST) {
        data.version = '1.1.1-test';
        data.port = 5454;
        data.token = 'APPSTORE_TOKEN';
        data.apiServerOrigin = 'http://localhost:6060'; // hock doesn't support https
        data.database.password = '';
        data.database.name = 'boxtest';
    }

    // overwrite defaults with saved config
    var existingData = safe.JSON.parse(safe.fs.readFileSync(cloudronConfigFileName, 'utf8'));
    _.extend(data, existingData);
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
function appFqdn(app) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof app.location, 'string');
    assert.strictEqual(typeof app.domain, 'string');

    if (app.location === '') return app.domain;

    // caas still has subdomains with a dash
    return app.location + (isCustomDomain() ? '.' : '-') + app.domain;
}

function mailLocation() {
    return get('adminLocation'); // not a typo! should be same as admin location until we figure out certificates
}

function mailFqdn() {
    return appFqdn({ domain: fqdn(), location: mailLocation() });
}

function adminLocation() {
    return get('adminLocation');
}

function adminFqdn() {
    return appFqdn({ domain: fqdn(), location: adminLocation() });
}

function adminOrigin() {
    return 'https://' + adminFqdn();
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

function hasIPv6() {
    const IPV6_PROC_FILE = '/proc/net/if_inet6';
    return fs.existsSync(IPV6_PROC_FILE);
}

function dkimSelector() {
    var loc = adminLocation();
    return loc === 'my' ? 'cloudron' : `cloudron-${loc.replace(/\./g, '')}`;
}

