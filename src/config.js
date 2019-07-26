'use strict';

exports = module.exports = {
    baseDir: baseDir,

    // values set here will be lost after a upgrade/update. use the sqlite database
    // for persistent values that need to be backed up
    set: set,

    // ifdefs to check environment
    CLOUDRON: process.env.BOX_ENV === 'cloudron',
    TEST: process.env.BOX_ENV === 'test',

    // convenience getters
    apiServerOrigin: apiServerOrigin,
    webServerOrigin: webServerOrigin,
    adminDomain: adminDomain,
    setFqdn: setAdminDomain,
    setAdminDomain: setAdminDomain,
    setAdminFqdn: setAdminFqdn,

    // these values are derived
    adminOrigin: adminOrigin,
    adminFqdn: adminFqdn,
    mailFqdn: mailFqdn,

    isDemo: isDemo,

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
    data.adminFqdn = '';
    data.adminDomain = '';
    data.apiServerOrigin = null;
    data.webServerOrigin = null;

    // overrides for local testings
    if (exports.TEST) {
        data.apiServerOrigin = 'http://localhost:6060'; // hock doesn't support https
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

function isDemo() {
    return get('isDemo') === true;
}

