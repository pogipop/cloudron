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
    adminDomain: adminDomain,
    setFqdn: setAdminDomain,
    setAdminDomain: setAdminDomain,
    setAdminFqdn: setAdminFqdn,
    setAdminLocation: setAdminLocation,
    version: version,
    database: database,
    edition: edition,

    // these values are derived
    adminOrigin: adminOrigin,
    internalAdminOrigin: internalAdminOrigin,
    sysadminOrigin: sysadminOrigin, // caas routes
    adminLocation: adminLocation,
    adminFqdn: adminFqdn,
    mailLocation: mailLocation,
    mailFqdn: mailFqdn,
    hasIPv6: hasIPv6,
    dkimSelector: dkimSelector,

    isDemo: isDemo,

    // feature flags based on editions (these have a separate license from standard edition)
    isSpacesEnabled: isSpacesEnabled,
    allowHyphenatedSubdomains: allowHyphenatedSubdomains,

    // for testing resets to defaults
    _reset: _reset
};

var assert = require('assert'),
    fs = require('fs'),
    path = require('path'),
    safe = require('safetydance'),
    _ = require('underscore');


// assert on unknown environment can't proceed
assert(exports.CLOUDRON || exports.TEST, 'Unknown environment. This should not happen!');

var data = { };

function baseDir() {
    const homeDir = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
    if (exports.CLOUDRON) return homeDir;
    if (exports.TEST) return path.join(homeDir, '.cloudron_test');
    // cannot reach
}

const cloudronConfigFileName = exports.CLOUDRON ? '/etc/cloudron/cloudron.conf' : path.join(baseDir(), 'cloudron.conf');

function saveSync() {
    // only save values we want to have in the cloudron.conf, see start.sh
    var conf = {
        apiServerOrigin: data.apiServerOrigin,
        webServerOrigin: data.webServerOrigin,
        adminDomain: data.adminDomain,
        adminFqdn: data.adminFqdn,
        adminLocation: data.adminLocation,
        provider: data.provider,
        isDemo: data.isDemo,
        edition: data.edition
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
    data.adminFqdn = '';
    data.adminDomain = '';
    data.adminLocation = 'my';
    data.port = 3000;
    data.apiServerOrigin = null;
    data.webServerOrigin = null;
    data.provider = 'generic';
    data.smtpPort = 2525; // this value comes from mail container
    data.sysadminPort = 3001;
    data.ldapPort = 3002;
    data.dockerProxyPort = 3003;
    data.edition = '';

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
        data.port = 5454;
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

function setAdminDomain(domain) {
    set('adminDomain', domain);
}

function adminDomain() {
    return get('adminDomain');
}

function mailLocation() {
    return get('adminLocation'); // not a typo! should be same as admin location until we figure out certificates
}

function setAdminLocation(location) {
    set('adminLocation', location);
}


function adminLocation() {
    return get('adminLocation');
}

function setAdminFqdn(adminFqdn) {
    set('adminFqdn', adminFqdn);
}

function adminFqdn() {
    return get('adminFqdn');
}

function mailFqdn() {
    return adminFqdn();
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

function version() {
    if (exports.TEST) return '3.0.0-test';
    return fs.readFileSync(path.join(__dirname, '../VERSION'), 'utf8').trim();
}

function database() {
    return get('database');
}

function isDemo() {
    return get('isDemo') === true;
}

function isSpacesEnabled() {
    return get('edition') === 'education';
}

function allowHyphenatedSubdomains() {
    // we should move caas also to hostingprovider edition at some point
    return get('edition') === 'hostingprovider' || get('provider') === 'caas';
}

function provider() {
    return get('provider');
}

function hasIPv6() {
    const IPV6_PROC_FILE = '/proc/net/if_inet6';
    return fs.existsSync(IPV6_PROC_FILE);
}

// it has to change with the adminLocation so that multiple cloudrons
// can send out emails at the same time.
function dkimSelector() {
    var loc = adminLocation();
    return loc === 'my' ? 'cloudron' : `cloudron-${loc.replace(/\./g, '')}`;
}

function edition() {
    return get('edition');
}
