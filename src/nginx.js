'use strict';

var assert = require('assert'),
    config = require('./config.js'),
    debug = require('debug')('box:nginx'),
    ejs = require('ejs'),
    fs = require('fs'),
    path = require('path'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    util = require('util');

exports = module.exports = {
    configureAdmin: configureAdmin,
    configureApp: configureApp,
    unconfigureApp: unconfigureApp,
    reload: reload,
    removeAppConfigs: removeAppConfigs,
    configureDefaultServer: configureDefaultServer
};

var NGINX_APPCONFIG_EJS = fs.readFileSync(__dirname + '/../setup/start/nginx/appconfig.ejs', { encoding: 'utf8' }),
    RELOAD_NGINX_CMD = path.join(__dirname, 'scripts/reloadnginx.sh');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

function configureAdmin(certFilePath, keyFilePath, configFileName, vhost, callback) {
    assert.strictEqual(typeof certFilePath, 'string');
    assert.strictEqual(typeof keyFilePath, 'string');
    assert.strictEqual(typeof configFileName, 'string');
    assert.strictEqual(typeof vhost, 'string');
    assert.strictEqual(typeof callback, 'function');

    var data = {
        sourceDir: path.resolve(__dirname, '..'),
        adminOrigin: config.adminOrigin(),
        vhost: vhost, // if vhost is empty it will become the default_server
        hasIPv6: config.hasIPv6(),
        endpoint: 'admin',
        certFilePath: certFilePath,
        keyFilePath: keyFilePath,
        xFrameOptions: 'SAMEORIGIN',
        robotsTxtQuoted: JSON.stringify('User-agent: *\nDisallow: /\n')
    };
    var nginxConf = ejs.render(NGINX_APPCONFIG_EJS, data);
    var nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, configFileName);

    if (!safe.fs.writeFileSync(nginxConfigFilename, nginxConf)) return callback(safe.error);

    reload(callback);
}

function configureApp(app, certFilePath, keyFilePath, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof certFilePath, 'string');
    assert.strictEqual(typeof keyFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    var sourceDir = path.resolve(__dirname, '..');
    var endpoint = 'app';
    var vhost = app.altDomain || app.intrinsicFqdn;

    var data = {
        sourceDir: sourceDir,
        adminOrigin: config.adminOrigin(),
        vhost: vhost,
        hasIPv6: config.hasIPv6(),
        port: app.httpPort,
        endpoint: endpoint,
        certFilePath: certFilePath,
        keyFilePath: keyFilePath,
        robotsTxtQuoted: app.robotsTxt ? JSON.stringify(app.robotsTxt) : null,
        xFrameOptions: app.xFrameOptions || 'SAMEORIGIN'    // once all apps have been updated/
    };
    var nginxConf = ejs.render(NGINX_APPCONFIG_EJS, data);

    var nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, app.id + '.conf');
    debug('writing config for "%s" to %s with options %j', vhost, nginxConfigFilename, data);

    if (!safe.fs.writeFileSync(nginxConfigFilename, nginxConf)) {
        debug('Error creating nginx config for "%s" : %s', vhost, safe.error.message);
        return callback(safe.error);
    }

    reload(callback);
}

function unconfigureApp(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    var vhost = app.altDomain || app.intrinsicFqdn;

    var nginxConfigFilename = path.join(paths.NGINX_APPCONFIG_DIR, app.id + '.conf');
    if (!safe.fs.unlinkSync(nginxConfigFilename)) {
        if (safe.error.code !== 'ENOENT') debug('Error removing nginx configuration of "%s": %s', vhost, safe.error.message);
        return callback(null);
    }

    reload(callback);
}

function reload(callback) {
    shell.sudo('reload', [ RELOAD_NGINX_CMD ], callback);
}

function removeAppConfigs() {
    for (var appConfigFile of fs.readdirSync(paths.NGINX_APPCONFIG_DIR)) {
        fs.unlinkSync(path.join(paths.NGINX_APPCONFIG_DIR, appConfigFile));
    }
}

function configureDefaultServer(callback) {
    callback = callback || NOOP_CALLBACK;

    if (process.env.BOX_ENV === 'test') return callback();

    var certFilePath = path.join(paths.NGINX_CERT_DIR,  'default.cert');
    var keyFilePath = path.join(paths.NGINX_CERT_DIR, 'default.key');

    if (!fs.existsSync(certFilePath) || !fs.existsSync(keyFilePath)) {
        debug('configureDefaultServer: create new cert');

        var cn = 'cloudron-' + (new Date()).toISOString(); // randomize date a bit to keep firefox happy
        var certCommand = util.format('openssl req -x509 -newkey rsa:2048 -keyout %s -out %s -days 3650 -subj /CN=%s -nodes', keyFilePath, certFilePath, cn);
        safe.child_process.execSync(certCommand);
    }

    configureAdmin(certFilePath, keyFilePath, 'default.conf', '', function (error) {
        if (error) return callback(error);

        debug('configureDefaultServer: done');

        callback(null);
    });
}
