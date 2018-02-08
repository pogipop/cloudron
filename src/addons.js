'use strict';

exports = module.exports = {
    setupAddons: setupAddons,
    teardownAddons: teardownAddons,
    backupAddons: backupAddons,
    restoreAddons: restoreAddons,

    getEnvironment: getEnvironment,
    getBindsSync: getBindsSync,
    getContainerNamesSync: getContainerNamesSync,

    // exported for testing
    _setupOauth: setupOauth,
    _teardownOauth: teardownOauth
};

var appdb = require('./appdb.js'),
    assert = require('assert'),
    async = require('async'),
    clients = require('./clients.js'),
    config = require('./config.js'),
    ClientsError = clients.ClientsError,
    debug = require('debug')('box:addons'),
    docker = require('./docker.js'),
    dockerConnection = docker.connection,
    fs = require('fs'),
    generatePassword = require('password-generator'),
    hat = require('hat'),
    infra = require('./infra_version.js'),
    mailboxdb = require('./mailboxdb.js'),
    once = require('once'),
    path = require('path'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    util = require('util');

var NOOP = function (app, options, callback) { return callback(); };

// setup can be called multiple times for the same app (configure crash restart) and existing data must not be lost
// teardown is destructive. app data stored with the addon is lost
var KNOWN_ADDONS = {
    email: {
        setup: setupEmail,
        teardown: teardownEmail,
        backup: NOOP,
        restore: setupEmail
    },
    ldap: {
        setup: setupLdap,
        teardown: teardownLdap,
        backup: NOOP,
        restore: setupLdap
    },
    localstorage: {
        setup: NOOP, // docker creates the directory for us
        teardown: NOOP,
        backup: NOOP, // no backup because it's already inside app data
        restore: NOOP
    },
    mongodb: {
        setup: setupMongoDb,
        teardown: teardownMongoDb,
        backup: backupMongoDb,
        restore: restoreMongoDb
    },
    mysql: {
        setup: setupMySql,
        teardown: teardownMySql,
        backup: backupMySql,
        restore: restoreMySql,
    },
    oauth: {
        setup: setupOauth,
        teardown: teardownOauth,
        backup: NOOP,
        restore: setupOauth
    },
    postgresql: {
        setup: setupPostgreSql,
        teardown: teardownPostgreSql,
        backup: backupPostgreSql,
        restore: restorePostgreSql
    },
    recvmail: {
        setup: setupRecvMail,
        teardown: teardownRecvMail,
        backup: NOOP,
        restore: setupRecvMail
    },
    redis: {
        setup: setupRedis,
        teardown: teardownRedis,
        backup: backupRedis,
        restore: setupRedis // same thing
    },
    sendmail: {
        setup: setupSendMail,
        teardown: teardownSendMail,
        backup: NOOP,
        restore: setupSendMail
    },
    scheduler: {
        setup: NOOP,
        teardown: NOOP,
        backup: NOOP,
        restore: NOOP
    }
};

var RMAPPDIR_CMD = path.join(__dirname, 'scripts/rmappdir.sh');

function debugApp(app, args) {
    assert(typeof app === 'object');

    debug(app.fqdn + ' ' + util.format.apply(util, Array.prototype.slice.call(arguments, 1)));
}

function setupAddons(app, addons, callback) {
    assert.strictEqual(typeof app, 'object');
    assert(!addons || typeof addons === 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!addons) return callback(null);

    debugApp(app, 'setupAddons: Setting up %j', Object.keys(addons));

    async.eachSeries(Object.keys(addons), function iterator(addon, iteratorCallback) {
        if (!(addon in KNOWN_ADDONS)) return iteratorCallback(new Error('No such addon:' + addon));

        debugApp(app, 'Setting up addon %s with options %j', addon, addons[addon]);

        KNOWN_ADDONS[addon].setup(app, addons[addon], iteratorCallback);
    }, callback);
}

function teardownAddons(app, addons, callback) {
    assert.strictEqual(typeof app, 'object');
    assert(!addons || typeof addons === 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!addons) return callback(null);

    debugApp(app, 'teardownAddons: Tearing down %j', Object.keys(addons));

    async.eachSeries(Object.keys(addons), function iterator(addon, iteratorCallback) {
        if (!(addon in KNOWN_ADDONS)) return iteratorCallback(new Error('No such addon:' + addon));

        debugApp(app, 'Tearing down addon %s with options %j', addon, addons[addon]);

        KNOWN_ADDONS[addon].teardown(app, addons[addon], iteratorCallback);
    }, callback);
}

function backupAddons(app, addons, callback) {
    assert.strictEqual(typeof app, 'object');
    assert(!addons || typeof addons === 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'backupAddons');

    if (!addons) return callback(null);

    debugApp(app, 'backupAddons: Backing up %j', Object.keys(addons));

    async.eachSeries(Object.keys(addons), function iterator (addon, iteratorCallback) {
        if (!(addon in KNOWN_ADDONS)) return iteratorCallback(new Error('No such addon:' + addon));

        KNOWN_ADDONS[addon].backup(app, addons[addon], iteratorCallback);
    }, callback);
}

function restoreAddons(app, addons, callback) {
    assert.strictEqual(typeof app, 'object');
    assert(!addons || typeof addons === 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'restoreAddons');

    if (!addons) return callback(null);

    debugApp(app, 'restoreAddons: restoring %j', Object.keys(addons));

    async.eachSeries(Object.keys(addons), function iterator (addon, iteratorCallback) {
        if (!(addon in KNOWN_ADDONS)) return iteratorCallback(new Error('No such addon:' + addon));

        KNOWN_ADDONS[addon].restore(app, addons[addon], iteratorCallback);
    }, callback);
}

function getEnvironment(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    appdb.getAddonConfigByAppId(app.id, function (error, result) {
        if (error) return callback(error);

        return callback(null, result.map(function (e) { return e.name + '=' + e.value; }));
    });
}

function getBindsSync(app, addons) {
    assert.strictEqual(typeof app, 'object');
    assert(!addons || typeof addons === 'object');

    var binds = [ ];

    if (!addons) return binds;

    for (var addon in addons) {
        switch (addon) {
        case 'localstorage': binds.push(path.join(paths.APPS_DATA_DIR, app.id, 'data') + ':/app/data:rw'); break;
        default: break;
        }
    }

    return binds;
}

function getContainerNamesSync(app, addons) {
    assert.strictEqual(typeof app, 'object');
    assert(!addons || typeof addons === 'object');

    var names = [ ];

    if (!addons) return names;

    for (var addon in addons) {
        switch (addon) {
        case 'scheduler':
            // names here depend on how scheduler.js creates containers
            names = names.concat(Object.keys(addons.scheduler).map(function (taskName) { return app.id + '-' + taskName; }));
            break;
        default: break;
        }
    }

    return names;
}

function setupOauth(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'setupOauth');

    if (!app.sso) return callback(null);

    var appId = app.id;
    var redirectURI = 'https://' + app.fqdn;
    var scope = 'profile';

    clients.delByAppIdAndType(appId, clients.TYPE_OAUTH, function (error) { // remove existing creds
        if (error && error.reason !== ClientsError.NOT_FOUND) return callback(error);

        clients.add(appId, clients.TYPE_OAUTH, redirectURI, scope, function (error, result) {
            if (error) return callback(error);

            var env = [
                { name: 'OAUTH_CLIENT_ID', value: result.id },
                { name: 'OAUTH_CLIENT_SECRET', value: result.clientSecret },
                { name: 'OAUTH_ORIGIN', value: config.adminOrigin() }
            ];

            debugApp(app, 'Setting oauth addon config to %j', env);

            appdb.setAddonConfig(appId, 'oauth', env, callback);
        });
    });
}

function teardownOauth(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'teardownOauth');

    clients.delByAppIdAndType(app.id, clients.TYPE_OAUTH, function (error) {
        if (error && error.reason !== ClientsError.NOT_FOUND) debug(error);

        appdb.unsetAddonConfig(app.id, 'oauth', callback);
    });
}

function setupEmail(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    // note that "external" access info can be derived from MAIL_DOMAIN (since it's part of user documentation)
    var env = [
        { name: 'MAIL_SMTP_SERVER', value: 'mail' },
        { name: 'MAIL_SMTP_PORT', value: '2525' },
        { name: 'MAIL_IMAP_SERVER', value: 'mail' },
        { name: 'MAIL_IMAP_PORT', value: '9993' },
        { name: 'MAIL_SIEVE_SERVER', value: 'mail' },
        { name: 'MAIL_SIEVE_PORT', value: '4190' },
        { name: 'MAIL_DOMAIN', value: app.domain }
    ];

    debugApp(app, 'Setting up Email');

    appdb.setAddonConfig(app.id, 'email', env, callback);
}

function teardownEmail(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Tearing down Email');

    appdb.unsetAddonConfig(app.id, 'email', callback);
}

function setupLdap(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!app.sso) return callback(null);

    var env = [
        { name: 'LDAP_SERVER', value: '172.18.0.1' },
        { name: 'LDAP_PORT', value: '' + config.get('ldapPort') },
        { name: 'LDAP_URL', value: 'ldap://172.18.0.1:' + config.get('ldapPort') },
        { name: 'LDAP_USERS_BASE_DN', value: 'ou=users,dc=cloudron' },
        { name: 'LDAP_GROUPS_BASE_DN', value: 'ou=groups,dc=cloudron' },
        { name: 'LDAP_BIND_DN', value: 'cn='+ app.id + ',ou=apps,dc=cloudron' },
        { name: 'LDAP_BIND_PASSWORD', value: hat(4 * 128) } // this is ignored
    ];

    debugApp(app, 'Setting up LDAP');

    appdb.setAddonConfig(app.id, 'ldap', env, callback);
}

function teardownLdap(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Tearing down LDAP');

    appdb.unsetAddonConfig(app.id, 'ldap', callback);
}

function setupSendMail(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up SendMail');

    mailboxdb.getByOwnerId(app.id, function (error, results) {
        if (error) return callback(error);

        var mailbox = results.filter(function (r) { return !r.aliasTarget; })[0];
        var password = generatePassword(128, false /* memorable */, /[\w\d_]/);

        var env = [
            { name: 'MAIL_SMTP_SERVER', value: 'mail' },
            { name: 'MAIL_SMTP_PORT', value: '2525' },
            { name: 'MAIL_SMTPS_PORT', value: '2465' },
            { name: 'MAIL_SMTP_USERNAME', value: mailbox.name + '@' + app.domain },
            { name: 'MAIL_SMTP_PASSWORD', value: password },
            { name: 'MAIL_FROM', value: mailbox.name + '@' + app.domain },
            { name: 'MAIL_DOMAIN', value: app.domain }
        ];
        debugApp(app, 'Setting sendmail addon config to %j', env);
        appdb.setAddonConfig(app.id, 'sendmail', env, callback);
    });
}

function teardownSendMail(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Tearing down sendmail');

    appdb.unsetAddonConfig(app.id, 'sendmail', callback);
}

function setupRecvMail(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up recvmail');

    mailboxdb.getByOwnerId(app.id, function (error, results) {
        if (error) return callback(error);

        var mailbox = results.filter(function (r) { return !r.aliasTarget; })[0];
        var password = generatePassword(128, false /* memorable */, /[\w\d_]/);

        var env = [
            { name: 'MAIL_IMAP_SERVER', value: 'mail' },
            { name: 'MAIL_IMAP_PORT', value: '9993' },
            { name: 'MAIL_IMAP_USERNAME', value: mailbox.name + '@' + app.domain },
            { name: 'MAIL_IMAP_PASSWORD', value: password },
            { name: 'MAIL_TO', value: mailbox.name + '@' + app.domain },
            { name: 'MAIL_DOMAIN', value: app.domain }
        ];

        debugApp(app, 'Setting sendmail addon config to %j', env);
        appdb.setAddonConfig(app.id, 'recvmail', env, callback);
    });
}

function teardownRecvMail(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Tearing down recvmail');

    appdb.unsetAddonConfig(app.id, 'recvmail', callback);
}

function setupMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up mysql');

    var cmd = [ '/addons/mysql/service.sh', options.multipleDatabases ? 'add-prefix' : 'add', app.id ];

    docker.execContainer('mysql', cmd, { bufferStdout: true }, function (error, stdout) {
        if (error) return callback(error);

        var result = stdout.toString('utf8').split('\n').slice(0, -1); // remove trailing newline
        var env = result.map(function (r) { var idx = r.indexOf('='); return { name: r.substr(0, idx), value: r.substr(idx + 1) }; });

        debugApp(app, 'Setting mysql addon config to %j', env);
        appdb.setAddonConfig(app.id, 'mysql', env, callback);
    });
}

function teardownMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    var cmd = [ '/addons/mysql/service.sh', options.multipleDatabases ? 'remove-prefix' : 'remove', app.id ];

    debugApp(app, 'Tearing down mysql');

    docker.execContainer('mysql', cmd, { }, function (error) {
        if (error) return callback(error);

        appdb.unsetAddonConfig(app.id, 'mysql', callback);
    });
}

function backupMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Backing up mysql');

    callback = once(callback); // ChildProcess exit may or may not be called after error

    var output = fs.createWriteStream(path.join(paths.APPS_DATA_DIR, app.id, 'mysqldump'));
    output.on('error', callback);

    var cmd = [ '/addons/mysql/service.sh', options.multipleDatabases ? 'backup-prefix' : 'backup', app.id ];

    docker.execContainer('mysql', cmd, { stdout: output }, callback);
}

function restoreMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback); // ChildProcess exit may or may not be called after error

    setupMySql(app, options, function (error) {
        if (error) return callback(error);

        debugApp(app, 'restoreMySql');

        var input = fs.createReadStream(path.join(paths.APPS_DATA_DIR, app.id, 'mysqldump'));
        input.on('error', callback);

        var cmd = [ '/addons/mysql/service.sh', options.multipleDatabases ? 'restore-prefix' : 'restore', app.id ];
        docker.execContainer('mysql', cmd, { stdin: input }, callback);
    });
}

function setupPostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up postgresql');

    var cmd = [ '/addons/postgresql/service.sh', 'add', app.id ];

    docker.execContainer('postgresql', cmd, { bufferStdout: true }, function (error, stdout) {
        if (error) return callback(error);

        var result = stdout.toString('utf8').split('\n').slice(0, -1); // remove trailing newline
        var env = result.map(function (r) { var idx = r.indexOf('='); return { name: r.substr(0, idx), value: r.substr(idx + 1) }; });

        debugApp(app, 'Setting postgresql addon config to %j', env);
        appdb.setAddonConfig(app.id, 'postgresql', env, callback);
    });
}

function teardownPostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    var cmd = [ '/addons/postgresql/service.sh', 'remove', app.id ];

    debugApp(app, 'Tearing down postgresql');

    docker.execContainer('postgresql', cmd, { }, function (error) {
        if (error) return callback(error);

        appdb.unsetAddonConfig(app.id, 'postgresql', callback);
    });
}

function backupPostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Backing up postgresql');

    callback = once(callback); // ChildProcess exit may or may not be called after error

    var output = fs.createWriteStream(path.join(paths.APPS_DATA_DIR, app.id, 'postgresqldump'));
    output.on('error', callback);

    var cmd = [ '/addons/postgresql/service.sh', 'backup', app.id ];

    docker.execContainer('postgresql', cmd, { stdout: output }, callback);
}

function restorePostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback);

    setupPostgreSql(app, options, function (error) {
        if (error) return callback(error);

        debugApp(app, 'restorePostgreSql');

        var input = fs.createReadStream(path.join(paths.APPS_DATA_DIR, app.id, 'postgresqldump'));
        input.on('error', callback);

        var cmd = [ '/addons/postgresql/service.sh', 'restore', app.id ];

        docker.execContainer('postgresql', cmd, { stdin: input }, callback);
    });
}

function setupMongoDb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up mongodb');

    var cmd = [ '/addons/mongodb/service.sh', 'add', app.id ];

    docker.execContainer('mongodb', cmd, { bufferStdout: true }, function (error, stdout) {
        if (error) return callback(error);

        var result = stdout.toString('utf8').split('\n').slice(0, -1); // remove trailing newline
        var env = result.map(function (r) { var idx = r.indexOf('='); return { name: r.substr(0, idx), value: r.substr(idx + 1) }; });

        debugApp(app, 'Setting mongodb addon config to %j', env);
        appdb.setAddonConfig(app.id, 'mongodb', env, callback);
    });
}

function teardownMongoDb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    var cmd = [ '/addons/mongodb/service.sh', 'remove', app.id ];

    debugApp(app, 'Tearing down mongodb');

    docker.execContainer('mongodb', cmd, { }, function (error) {
        if (error) return callback(error);

        appdb.unsetAddonConfig(app.id, 'mongodb', callback);
    });
}

function backupMongoDb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Backing up mongodb');

    callback = once(callback); // ChildProcess exit may or may not be called after error

    var output = fs.createWriteStream(path.join(paths.APPS_DATA_DIR, app.id, 'mongodbdump'));
    output.on('error', callback);

    var cmd = [ '/addons/mongodb/service.sh', 'backup', app.id ];

    docker.execContainer('mongodb', cmd, { stdout: output }, callback);
}

function restoreMongoDb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback); // ChildProcess exit may or may not be called after error

    setupMongoDb(app, options, function (error) {
        if (error) return callback(error);

        debugApp(app, 'restoreMongoDb');

        var input = fs.createReadStream(path.join(paths.APPS_DATA_DIR, app.id, 'mongodbdump'));
        input.on('error', callback);

        var cmd = [ '/addons/mongodb/service.sh', 'restore', app.id ];
        docker.execContainer('mongodb', cmd, { stdin: input }, callback);
    });
}

// Ensures that app's addon redis container is running. Can be called when named container already exists/running
function setupRedis(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    var redisPassword = generatePassword(128, false /* memorable */, /[\w\d_]/); // ensure no / in password for being sed friendly (and be uri friendly)
    var redisVarsFile = path.join(paths.ADDON_CONFIG_DIR, 'redis-' + app.id + '_vars.sh');
    var redisDataDir = path.join(paths.APPS_DATA_DIR, app.id + '/redis');

    if (!safe.fs.writeFileSync(redisVarsFile, 'REDIS_PASSWORD=' + redisPassword)) {
        return callback(new Error('Error writing redis config'));
    }

    if (!safe.fs.mkdirSync(redisDataDir) && safe.error.code !== 'EEXIST') return callback(new Error('Error creating redis data dir:' + safe.error));

    // Compute redis memory limit based on app's memory limit (this is arbitrary)
    var memoryLimit = app.memoryLimit || app.manifest.memoryLimit || 0;

    if (memoryLimit === -1) { // unrestricted (debug mode)
        memoryLimit = 0;
    } else if (memoryLimit === 0 || memoryLimit <= (2 * 1024 * 1024 * 1024)) { // less than 2G (ram+swap)
        memoryLimit = 150 * 1024 * 1024; // 150m
    } else {
        memoryLimit = 600 * 1024 * 1024; // 600m
    }

    const tag = infra.images.redis.tag, redisName = 'redis-' + app.id;
    const label = app.fqdn;
    // note that we do not add appId label because this interferes with the stop/start app logic
    const cmd = `docker run --restart=always -d --name=${redisName} \
                --label=location=${label} \
                --net cloudron \
                --net-alias ${redisName} \
                -m ${memoryLimit/2} \
                --memory-swap ${memoryLimit} \
                --dns 172.18.0.1 \
                --dns-search=. \
                -v ${redisVarsFile}:/etc/redis/redis_vars.sh:ro \
                -v ${redisDataDir}:/var/lib/redis:rw \
                --read-only -v /tmp -v /run ${tag}`;

    var env = [
        { name: 'REDIS_URL', value: 'redis://redisuser:' + redisPassword + '@redis-' + app.id },
        { name: 'REDIS_PASSWORD', value: redisPassword },
        { name: 'REDIS_HOST', value: redisName },
        { name: 'REDIS_PORT', value: '6379' }
    ];

    async.series([
        // stop so that redis can flush itself with SIGTERM
        shell.execSync.bind(null, 'stopRedis', `docker stop --time=10 ${redisName} 2>/dev/null || true`),
        shell.execSync.bind(null, 'stopRedis', `docker rm --volumes ${redisName} 2>/dev/null || true`),
        shell.execSync.bind(null, 'startRedis', cmd),
        appdb.setAddonConfig.bind(null, app.id, 'redis', env)
    ], function (error) {
        if (error) debug('Error setting up redis: ', error);
        callback(error);
    });
}

function teardownRedis(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    var container = dockerConnection.getContainer('redis-' + app.id);

    var removeOptions = {
        force: true, // kill container if it's running
        v: true // removes volumes associated with the container
    };

    container.remove(removeOptions, function (error) {
        if (error && error.statusCode !== 404) return callback(new Error('Error removing container:' + error));

        safe.fs.unlinkSync(paths.ADDON_CONFIG_DIR, 'redis-' + app.id + '_vars.sh');

        shell.sudo('teardownRedis', [ RMAPPDIR_CMD, app.id + '/redis', true /* delete directory */ ], function (error, stdout, stderr) {
            if (error) return callback(new Error('Error removing redis data:' + error));

            appdb.unsetAddonConfig(app.id, 'redis', callback);
        });
    });
}

function backupRedis(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Backing up redis');

    var cmd = [ '/addons/redis/service.sh', 'backup' ]; // the redis dir is volume mounted

    docker.execContainer('redis-' + app.id, cmd, { }, callback);
}
