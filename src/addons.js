'use strict';

exports = module.exports = {
    setupAddons: setupAddons,
    teardownAddons: teardownAddons,
    backupAddons: backupAddons,
    restoreAddons: restoreAddons,
    clearAddons: clearAddons,

    getEnvironment: getEnvironment,
    getMountsSync: getMountsSync,
    getContainerNamesSync: getContainerNamesSync,

    // exported for testing
    _setupOauth: setupOauth,
    _teardownOauth: teardownOauth
};

var accesscontrol = require('./accesscontrol.js'),
    appdb = require('./appdb.js'),
    assert = require('assert'),
    async = require('async'),
    clients = require('./clients.js'),
    config = require('./config.js'),
    ClientsError = clients.ClientsError,
    crypto = require('crypto'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:addons'),
    docker = require('./docker.js'),
    dockerConnection = docker.connection,
    fs = require('fs'),
    hat = require('./hat.js'),
    infra = require('./infra_version.js'),
    mail = require('./mail.js'),
    mailboxdb = require('./mailboxdb.js'),
    once = require('once'),
    path = require('path'),
    paths = require('./paths.js'),
    rimraf = require('rimraf'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    request = require('request'),
    util = require('util');

var NOOP = function (app, options, callback) { return callback(); };
const RMREDIS_CMD = path.join(__dirname, 'scripts/rmredis.sh');

// setup can be called multiple times for the same app (configure crash restart) and existing data must not be lost
// teardown is destructive. app data stored with the addon is lost
var KNOWN_ADDONS = {
    email: {
        setup: setupEmail,
        teardown: teardownEmail,
        backup: NOOP,
        restore: setupEmail,
        clear: NOOP
    },
    ldap: {
        setup: setupLdap,
        teardown: teardownLdap,
        backup: NOOP,
        restore: setupLdap,
        clear: NOOP
    },
    localstorage: {
        setup: setupLocalStorage, // docker creates the directory for us
        teardown: teardownLocalStorage,
        backup: NOOP, // no backup because it's already inside app data
        restore: NOOP,
        clear: clearLocalStorage
    },
    mongodb: {
        setup: setupMongoDb,
        teardown: teardownMongoDb,
        backup: backupMongoDb,
        restore: restoreMongoDb,
        clear: clearMongodb
    },
    mysql: {
        setup: setupMySql,
        teardown: teardownMySql,
        backup: backupMySql,
        restore: restoreMySql,
        clear: clearMySql
    },
    oauth: {
        setup: setupOauth,
        teardown: teardownOauth,
        backup: NOOP,
        restore: setupOauth,
        clear: NOOP
    },
    postgresql: {
        setup: setupPostgreSql,
        teardown: teardownPostgreSql,
        backup: backupPostgreSql,
        restore: restorePostgreSql,
        clear: clearPostgreSql
    },
    recvmail: {
        setup: setupRecvMail,
        teardown: teardownRecvMail,
        backup: NOOP,
        restore: setupRecvMail,
        clear: NOOP
    },
    redis: {
        setup: setupRedis,
        teardown: teardownRedis,
        backup: backupRedis,
        restore: restoreRedis,
        clear: clearRedis
    },
    sendmail: {
        setup: setupSendMail,
        teardown: teardownSendMail,
        backup: NOOP,
        restore: setupSendMail,
        clear: NOOP
    },
    scheduler: {
        setup: NOOP,
        teardown: NOOP,
        backup: NOOP,
        restore: NOOP,
        clear: NOOP
    },
    docker: {
        setup: NOOP,
        teardown: NOOP,
        backup: NOOP,
        restore: NOOP,
        clear: NOOP
    }
};

function debugApp(app, args) {
    assert(typeof app === 'object');

    debug(app.fqdn + ' ' + util.format.apply(util, Array.prototype.slice.call(arguments, 1)));
}

function getAddonDetails(containerName, tokenEnvName, callback) {
    assert.strictEqual(typeof containerName, 'string');
    assert.strictEqual(typeof tokenEnvName, 'string');
    assert.strictEqual(typeof callback, 'function');

    var container = dockerConnection.getContainer(containerName);
    container.inspect(function (error, result) {
        if (error) return callback(new Error(`Error inspecting ${containerName} container: ` + error));

        const ip = safe.query(result, 'NetworkSettings.Networks.cloudron.IPAddress', null);
        if (!ip) return callback(new Error(`Error getting ${containerName} container ip`));

        // extract the cloudron token for auth
        const env = safe.query(result, 'Config.Env', null);
        if (!env) return callback(new Error(`Error getting ${containerName} env`));
        const tmp = env.find(function (e) { return e.indexOf(tokenEnvName) === 0; });
        if (!tmp) return callback(new Error(`Error getting ${containerName} cloudron token env var`));
        const token = tmp.slice(tokenEnvName.length + 1); // +1 for the = sign
        if (!token)  return callback(new Error(`Error getting ${containerName} cloudron token`));

        callback(null, { ip: ip, token: token });
    });
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

function clearAddons(app, addons, callback) {
    assert.strictEqual(typeof app, 'object');
    assert(!addons || typeof addons === 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'clearAddons');

    if (!addons) return callback(null);

    debugApp(app, 'clearAddons: clearing %j', Object.keys(addons));

    async.eachSeries(Object.keys(addons), function iterator (addon, iteratorCallback) {
        if (!(addon in KNOWN_ADDONS)) return iteratorCallback(new Error('No such addon:' + addon));

        KNOWN_ADDONS[addon].clear(app, addons[addon], iteratorCallback);
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

        if (app.manifest.addons['docker']) result.push({ name: 'DOCKER_HOST', value: `tcp://172.18.0.1:${config.get('dockerProxyPort')}` });

        return callback(null, result.map(function (e) { return e.name + '=' + e.value; }));
    });
}

function getMountsSync(app, addons) {
    assert.strictEqual(typeof app, 'object');
    assert(!addons || typeof addons === 'object');

    let mounts = [ ];

    if (!addons) return mounts;

    for (let addon in addons) {
        switch (addon) {
        case 'localstorage':
            mounts.push({
                Target: '/app/data',
                Source: `${app.id}-localstorage`,
                Type: 'volume',
                ReadOnly: false
            });
            break;
        default: break;
        }
    }

    return mounts;
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

function setupLocalStorage(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'setupLocalStorage');

    // if you change the name, you have to change getMountsSync
    docker.createVolume(app, `${app.id}-localstorage`, 'data', callback);
}

function clearLocalStorage(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'clearLocalStorage');

    docker.clearVolume(app, `${app.id}-localstorage`, 'data', callback);
}

function teardownLocalStorage(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'teardownLocalStorage');

    docker.removeVolume(app, `${app.id}-localstorage`, 'data', callback);
}

function setupOauth(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'setupOauth');

    if (!app.sso) return callback(null);

    var appId = app.id;
    var redirectURI = 'https://' + app.fqdn;
    var scope = accesscontrol.SCOPE_PROFILE;

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

    mail.getDomains(function (error, mailDomains) {
        if (error) return callback(error);

        const mailInDomains = mailDomains.filter(function (d) { return d.enabled; }).map(function (d) { return d.domain; }).join(',');

        // note that "external" access info can be derived from MAIL_DOMAIN (since it's part of user documentation)
        var env = [
            { name: 'MAIL_SMTP_SERVER', value: 'mail' },
            { name: 'MAIL_SMTP_PORT', value: '2525' },
            { name: 'MAIL_IMAP_SERVER', value: 'mail' },
            { name: 'MAIL_IMAP_PORT', value: '9993' },
            { name: 'MAIL_SIEVE_SERVER', value: 'mail' },
            { name: 'MAIL_SIEVE_PORT', value: '4190' },
            { name: 'MAIL_DOMAIN', value: app.domain },
            { name: 'MAIL_DOMAINS', value: mailInDomains }
        ];

        debugApp(app, 'Setting up Email');

        appdb.setAddonConfig(app.id, 'email', env, callback);
    });
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

    appdb.getAddonConfigByName(app.id, 'sendmail', 'MAIL_SMTP_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        var password = error ? hat(4 * 48) : existingPassword; // see box#565 for password length

        mailboxdb.getByOwnerId(app.id, function (error, results) {
            if (error) return callback(error);

            var mailbox = results.filter(function (r) { return !r.aliasTarget; })[0];

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

    appdb.getAddonConfigByName(app.id, 'recvmail', 'MAIL_IMAP_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        var password = error ? hat(4 * 48) : existingPassword;  // see box#565 for password length

        mailboxdb.getByOwnerId(app.id, function (error, results) {
            if (error) return callback(error);

            var mailbox = results.filter(function (r) { return !r.aliasTarget; })[0];

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
    });
}

function teardownRecvMail(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Tearing down recvmail');

    appdb.unsetAddonConfig(app.id, 'recvmail', callback);
}

function mysqlDatabaseName(appId) {
    assert.strictEqual(typeof appId, 'string');

    var md5sum = crypto.createHash('md5'); // get rid of "-"
    md5sum.update(appId);
    return md5sum.digest('hex').substring(0, 16);  // max length of mysql usernames is 16
}

function setupMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up mysql');

    appdb.getAddonConfigByName(app.id, 'mysql', 'MYSQL_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        const tmp = mysqlDatabaseName(app.id);

        const data = {
            database: tmp,
            prefix: tmp,
            username: tmp,
            password: error ? hat(4 * 48) : existingPassword // see box#362 for password length
        };

        getAddonDetails('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error, result) {
            if (error) return callback(error);

            request.post(`https://${result.ip}:3000/` + (options.multipleDatabases ? 'prefixes' : 'databases') + `?access_token=${result.token}`, { rejectUnauthorized: false, json: data }, function (error, response) {
                if (error) return callback(new Error('Error setting up mysql: ' + error));
                if (response.statusCode !== 201) return callback(new Error(`Error setting up mysql. Status code: ${response.statusCode}`));

                var env = [
                    { name: 'MYSQL_USERNAME', value: data.username },
                    { name: 'MYSQL_PASSWORD', value: data.password },
                    { name: 'MYSQL_HOST', value: 'mysql' },
                    { name: 'MYSQL_PORT', value: '3306' }
                ];

                if (options.multipleDatabases) {
                    env = env.concat({ name: 'MYSQL_DATABASE_PREFIX', value: `${data.prefix}_` });
                } else {
                    env = env.concat(
                        { name: 'MYSQL_URL', value: `mysql://${data.username}:${data.password}@mysql/${data.database}` },
                        { name: 'MYSQL_DATABASE', value: data.database }
                    );
                }

                debugApp(app, 'Setting mysql addon config to %j', env);
                appdb.setAddonConfig(app.id, 'mysql', env, callback);
            });
        });
    });
}

function clearMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    const database = mysqlDatabaseName(app.id);

    getAddonDetails('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error, result) {
        if (error) return callback(error);

        request.post(`https://${result.ip}:3000/` + (options.multipleDatabases ? 'prefixes' : 'databases') + `/${database}/clear?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(new Error('Error clearing mysql: ' + error));
            if (response.statusCode !== 200) return callback(new Error(`Error clearing mysql. Status code: ${response.statusCode}`));
            callback();
        });
    });
}

function teardownMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    const database = mysqlDatabaseName(app.id);
    const username = database;

    getAddonDetails('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error, result) {
        if (error) return callback(error);

        request.delete(`https://${result.ip}:3000/` + (options.multipleDatabases ? 'prefixes' : 'databases') + `/${database}?access_token=${result.token}&username=${username}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(new Error('Error clearing mysql: ' + error));
            if (response.statusCode !== 200) return callback(new Error(`Error clearing mysql. Status code: ${response.statusCode}`));

            appdb.unsetAddonConfig(app.id, 'mysql', callback);
        });
    });
}

function backupMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    const database = mysqlDatabaseName(app.id);

    debugApp(app, 'Backing up mysql');

    callback = once(callback); // protect from multiple returns with streams

    getAddonDetails('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error, result) {
        if (error) return callback(error);

        const writeStream = fs.createWriteStream(path.join(paths.APPS_DATA_DIR, app.id, 'mysqldump'));
        writeStream.on('error', callback);

        const req = request.post(`https://${result.ip}:3000/` + (options.multipleDatabases ? 'prefixes' : 'databases') + `/${database}/backup?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(error);
            if (response.statusCode !== 200) return callback(new Error(`Unexpected response from mysql addon ${response.statusCode}`));

            callback(null);
        });
        req.pipe(writeStream);
    });
}

function restoreMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    const database = mysqlDatabaseName(app.id);

    debugApp(app, 'restoreMySql');

    callback = once(callback); // protect from multiple returns with streams

    getAddonDetails('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error, result) {
        if (error) return callback(error);

        var input = fs.createReadStream(path.join(paths.APPS_DATA_DIR, app.id, 'mysqldump'));
        input.on('error', callback);

        const restoreReq = request.post(`https://${result.ip}:3000/` + (options.multipleDatabases ? 'prefixes' : 'databases') + `/${database}/restore?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(error);
            if (response.statusCode !== 200) return callback(new Error(`Unexpected response from mysql addon ${response.statusCode}`));

            callback(null);
        });

        input.pipe(restoreReq);
    });
}

function postgreSqlNames(appId) {
    appId = appId.replace(/-/g, '');
    return { database: `db${appId}`, username: `user${appId}` };
}

function setupPostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up postgresql');

    const { database, username } = postgreSqlNames(app.id);

    appdb.getAddonConfigByName(app.id, 'postgresql', 'POSTGRESQL_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        const data = {
            database: database,
            username: username,
            password: error ? hat(4 * 128) : existingPassword
        };

        getAddonDetails('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error, result) {
            if (error) return callback(error);

            request.post(`https://${result.ip}:3000/databases?access_token=${result.token}`, { rejectUnauthorized: false, json: data }, function (error, response) {
                if (error) return callback(new Error('Error setting up postgresql: ' + error));
                if (response.statusCode !== 201) return callback(new Error(`Error setting up postgresql. Status code: ${response.statusCode} message: ${response.body.message}`));

                var env = [
                    { name: 'POSTGRESQL_URL', value: `postgres://${data.username}:${data.password}@postgresql/${data.database}` },
                    { name: 'POSTGRESQL_USERNAME', value: data.username },
                    { name: 'POSTGRESQL_PASSWORD', value: data.password },
                    { name: 'POSTGRESQL_HOST', value: 'postgresql' },
                    { name: 'POSTGRESQL_PORT', value: '5432' },
                    { name: 'POSTGRESQL_DATABASE', value: data.database }
                ];

                debugApp(app, 'Setting postgresql addon config to %j', env);
                appdb.setAddonConfig(app.id, 'postgresql', env, callback);
            });
        });
    });
}

function clearPostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    const { database, username } = postgreSqlNames(app.id);

    debugApp(app, 'Clearing postgresql');

    getAddonDetails('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error, result) {
        if (error) return callback(error);

        request.post(`https://${result.ip}:3000/databases/${database}/clear?access_token=${result.token}&username=${username}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(new Error('Error clearing postgresql: ' + error));
            if (response.statusCode !== 200) return callback(new Error(`Error clearing postgresql. Status code: ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });
    });
}

function teardownPostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    const { database, username } = postgreSqlNames(app.id);

    getAddonDetails('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error, result) {
        if (error) return callback(error);

        request.delete(`https://${result.ip}:3000/databases/${database}?access_token=${result.token}&username=${username}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(new Error('Error tearing down postgresql: ' + error));
            if (response.statusCode !== 200) return callback(new Error(`Error tearing down postgresql. Status code: ${response.statusCode} message: ${response.body.message}`));

            appdb.unsetAddonConfig(app.id, 'postgresql', callback);
        });
    });
}

function backupPostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Backing up postgresql');

    const { database } = postgreSqlNames(app.id);

    callback = once(callback); // protect from multiple returns with streams

    getAddonDetails('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error, result) {
        if (error) return callback(error);

        const writeStream = fs.createWriteStream(path.join(paths.APPS_DATA_DIR, app.id, 'postgresqldump'));
        writeStream.on('error', callback);

        const req = request.post(`https://${result.ip}:3000/databases/${database}/backup?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(error);
            if (response.statusCode !== 200) return callback(new Error(`Unexpected response from postgresql addon ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });
        req.pipe(writeStream);
    });
}

function restorePostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Restore postgresql');

    const { database, username } = postgreSqlNames(app.id);

    callback = once(callback); // protect from multiple returns with streams

    getAddonDetails('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error, result) {
        if (error) return callback(error);

    var input = fs.createReadStream(path.join(paths.APPS_DATA_DIR, app.id, 'postgresqldump'));
    input.on('error', callback);

        const restoreReq = request.post(`https://${result.ip}:3000/databases/${database}/restore?access_token=${result.token}&username=${username}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(error);
            if (response.statusCode !== 200) return callback(new Error(`Unexpected response from postgresql addon ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });

        input.pipe(restoreReq);
    });
}

function setupMongoDb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up mongodb');

    appdb.getAddonConfigByName(app.id, 'mongodb', 'MONGODB_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        const data = {
            database: app.id,
            username: app.id,
            password: error ? hat(4 * 128) : existingPassword
        };

        getAddonDetails('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error, result) {
            if (error) return callback(error);

            request.post(`https://${result.ip}:3000/databases?access_token=${result.token}`, { rejectUnauthorized: false, json: data }, function (error, response) {
                if (error) return callback(new Error('Error setting up mongodb: ' + error));
                if (response.statusCode !== 201) return callback(new Error(`Error setting up mongodb. Status code: ${response.statusCode}`));

                var env = [
                    { name: 'MONGODB_URL', value : `mongodb://${data.username}:${data.password}@mongodb/${data.database} message: ${response.body.message}` },
                    { name: 'MONGODB_USERNAME', value : data.username },
                    { name: 'MONGODB_PASSWORD', value: data.password },
                    { name: 'MONGODB_HOST', value : 'mongodb' },
                    { name: 'MONGODB_PORT', value : '27017' },
                    { name: 'MONGODB_DATABASE', value : data.database }
                ];

                debugApp(app, 'Setting mongodb addon config to %j', env);
                appdb.setAddonConfig(app.id, 'mongodb', env, callback);
            });
        });
    });
}

function clearMongodb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Clearing mongodb');

    getAddonDetails('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error, result) {
        if (error) return callback(error);

        request.post(`https://${result.ip}:3000/databases/${app.id}/clear?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(new Error('Error clearing mongodb: ' + error));
            if (response.statusCode !== 200) return callback(new Error(`Error clearing mongodb. Status code: ${response.statusCode} message: ${response.body.message}`));

            callback();
        });
    });
}

function teardownMongoDb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Tearing down mongodb');

    getAddonDetails('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error, result) {
        if (error) return callback(error);

        request.delete(`https://${result.ip}:3000/databases/${app.id}?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(new Error('Error tearing down mongodb: ' + error));
            if (response.statusCode !== 200) return callback(new Error(`Error tearing down mongodb. Status code: ${response.statusCode} message: ${response.body.message}`));

            appdb.unsetAddonConfig(app.id, 'mongodb', callback);
        });
    });
}

function backupMongoDb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Backing up mongodb');

    callback = once(callback); // protect from multiple returns with streams

    getAddonDetails('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error, result) {
        if (error) return callback(error);

        const writeStream = fs.createWriteStream(path.join(paths.APPS_DATA_DIR, app.id, 'mongodbdump'));
        writeStream.on('error', callback);

        const req = request.post(`https://${result.ip}:3000/databases/${app.id}/backup?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(error);
            if (response.statusCode !== 200) return callback(new Error(`Unexpected response from mongodb addon ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });
        req.pipe(writeStream);
    });
}

function restoreMongoDb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback); // protect from multiple returns with streams

    debugApp(app, 'restoreMongoDb');

    getAddonDetails('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error, result) {
        if (error) return callback(error);

        const readStream = fs.createReadStream(path.join(paths.APPS_DATA_DIR, app.id, 'mongodbdump'));
        readStream.on('error', callback);

        const restoreReq = request.post(`https://${result.ip}:3000/databases/${app.id}/restore?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(error);
            if (response.statusCode !== 200) return callback(new Error(`Unexpected response from mongodb addon ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });

        readStream.pipe(restoreReq);
    });
}

// Ensures that app's addon redis container is running. Can be called when named container already exists/running
function setupRedis(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    const redisName = 'redis-' + app.id;

    docker.inspect(redisName, function (error, result) {
        if (!error) {
            debug(`Re-using existing redis container with state: ${result.State}`);
            return callback();
        }

        appdb.getAddonConfigByName(app.id, 'redis', 'REDIS_PASSWORD', function (error, existingPassword) {
            if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

            const redisPassword = error ? hat(4 * 48) : existingPassword; // see box#362 for password length
            const redisServiceToken = hat(4 * 48);

            // Compute redis memory limit based on app's memory limit (this is arbitrary)
            var memoryLimit = app.memoryLimit || app.manifest.memoryLimit || 0;

            if (memoryLimit === -1) { // unrestricted (debug mode)
                memoryLimit = 0;
            } else if (memoryLimit === 0 || memoryLimit <= (2 * 1024 * 1024 * 1024)) { // less than 2G (ram+swap)
                memoryLimit = 150 * 1024 * 1024; // 150m
            } else {
                memoryLimit = 600 * 1024 * 1024; // 600m
            }

            const tag = infra.images.redis.tag;
            const label = app.fqdn;
            // note that we do not add appId label because this interferes with the stop/start app logic
            const cmd = `docker run --restart=always -d --name=${redisName} \
                        --label=location=${label} \
                        --net cloudron \
                        --net-alias ${redisName} \
                        --log-driver syslog \
                        --log-opt syslog-address=udp://127.0.0.1:2514 \
                        --log-opt syslog-format=rfc5424 \
                        --log-opt tag="${redisName}" \
                        -m ${memoryLimit/2} \
                        --memory-swap ${memoryLimit} \
                        --dns 172.18.0.1 \
                        --dns-search=. \
                        -e CLOUDRON_REDIS_PASSWORD="${redisPassword}" \
                        -e CLOUDRON_REDIS_TOKEN="${redisServiceToken}" \
                        -v "${paths.PLATFORM_DATA_DIR}/redis/${app.id}:/var/lib/redis" \
                        --read-only -v /tmp -v /run ${tag}`;

            var env = [
                { name: 'REDIS_URL', value: 'redis://redisuser:' + redisPassword + '@redis-' + app.id },
                { name: 'REDIS_PASSWORD', value: redisPassword },
                { name: 'REDIS_HOST', value: redisName },
                { name: 'REDIS_PORT', value: '6379' }
            ];

            async.series([
                shell.execSync.bind(null, 'startRedis', cmd),
                appdb.setAddonConfig.bind(null, app.id, 'redis', env),
                function (next) { setTimeout(next, 3000); } // waitForRedis
            ], function (error) {
                if (error) debug('Error setting up redis: ', error);
                callback(error);
            });
        });
    });
}

function clearRedis(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Clearing redis');

    getAddonDetails('redis-' + app.id, 'CLOUDRON_REDIS_TOKEN', function (error, result) {
        if (error) return callback(error);

        request.post(`https://${result.ip}:3000/clear?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(new Error('Error clearing redis: ' + error));
            if (response.statusCode !== 200) return callback(new Error(`Error clearing redis. Status code: ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });
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

        shell.sudo('removeVolume', [ RMREDIS_CMD, app.id ], function (error) {
            if (error) return callback(new Error('Error removing redis data:' + error));

            rimraf(path.join(paths.LOG_DIR, `redis-${app.id}`), function (error) {
                if (error) debugApp(app, 'cannot cleanup logs: %s', error);

                appdb.unsetAddonConfig(app.id, 'redis', callback);
            });
        });
    });
}

function backupRedis(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Backing up redis');

    callback = once(callback); // protect from multiple returns with streams

    getAddonDetails('redis-' + app.id, 'CLOUDRON_REDIS_TOKEN', function (error, result) {
        if (error) return callback(error);

        const writeStream = fs.createWriteStream(path.join(paths.APPS_DATA_DIR, app.id, 'dump.rdb'));
        writeStream.on('error', callback);

        const req = request.post(`https://${result.ip}:3000/backup?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(new Error('Error backing up redis: ' + error));
            if (response.statusCode !== 200) return callback(new Error(`Error backing up redis. Status code: ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });
        req.pipe(writeStream);
    });
}

function restoreRedis(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Restoring redis');

    getAddonDetails('redis-' + app.id, 'CLOUDRON_REDIS_TOKEN', function (error, result) {
        if (error) return callback(error);

        var input = fs.createReadStream(path.join(paths.APPS_DATA_DIR, app.id, 'dump.rdb'));
        input.on('error', callback);

        const restoreReq = request.post(`https://${result.ip}:3000/restore?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(error);
            if (response.statusCode !== 200) return callback(new Error(`Unexpected response from redis addon: ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });

        input.pipe(restoreReq);
    });
}
