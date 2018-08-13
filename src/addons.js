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
    },
    docker: {
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

        if (app.manifest.addons['docker']) result.push({ name: 'DOCKER_URL', value: `tcp://172.18.0.1:${config.get('dockerProxyPort')}` });

        return callback(null, result.map(function (e) { return e.name + '=' + e.value; }));
    });
}

function getBindsSync(app, addons) {
    assert.strictEqual(typeof app, 'object');
    assert(!addons || typeof addons === 'object');

    let binds = [ ];

    if (!addons) return binds;

    for (let addon in addons) {
        switch (addon) {
        case 'localstorage':
            binds.push(path.join(paths.APPS_DATA_DIR, app.id, 'data') + ':/app/data:rw');
            if (!Array.isArray(addons[addon].bindMounts)) break;

            for (let mount of addons[addon].bindMounts) {
                let [ host, container ] = mount.split(':');
                binds.push(path.join(paths.APPS_DATA_DIR, app.id, 'data', path.normalize(host)) + ':' + container);
            }
            break;
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

        const dbname = mysqlDatabaseName(app.id);
        const password = error ? hat(4 * 48) : existingPassword; // see box#362 for password length

        var cmd = [ '/addons/mysql/service.sh', options.multipleDatabases ? 'add-prefix' : 'add', dbname, password ];

        docker.execContainer('mysql', cmd, { bufferStdout: true }, function (error) {
            if (error) return callback(error);

            var env = [
                { name: 'MYSQL_USERNAME', value: dbname },
                { name: 'MYSQL_PASSWORD', value: password },
                { name: 'MYSQL_HOST', value: 'mysql' },
                { name: 'MYSQL_PORT', value: '3306' }
            ];

            if (options.multipleDatabases) {
                env = env.concat({ name: 'MYSQL_DATABASE_PREFIX', value: `${dbname}_` });
            } else {
                env = env.concat(
                    { name: 'MYSQL_URL', value: `mysql://${dbname}:${password}@mysql/${dbname}` },
                    { name: 'MYSQL_DATABASE', value: dbname }
                );
            }

            debugApp(app, 'Setting mysql addon config to %j', env);
            appdb.setAddonConfig(app.id, 'mysql', env, callback);
        });
    });
}

function teardownMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    const dbname = mysqlDatabaseName(app.id);
    var cmd = [ '/addons/mysql/service.sh', options.multipleDatabases ? 'remove-prefix' : 'remove', dbname ];

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

    const dbname = mysqlDatabaseName(app.id);
    var cmd = [ '/addons/mysql/service.sh', options.multipleDatabases ? 'backup-prefix' : 'backup', dbname ];

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

        const dbname = mysqlDatabaseName(app.id);
        var cmd = [ '/addons/mysql/service.sh', options.multipleDatabases ? 'restore-prefix' : 'restore', dbname ];
        docker.execContainer('mysql', cmd, { stdin: input }, callback);
    });
}

function setupPostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up postgresql');

    appdb.getAddonConfigByName(app.id, 'postgresql', 'POSTGRESQL_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        const password = error ? hat(4 * 128) : existingPassword;
        const appId = app.id.replace(/-/g, '');

        var cmd = [ '/addons/postgresql/service.sh', 'add', appId, password ];

        docker.execContainer('postgresql', cmd, { bufferStdout: true }, function (error) {
            if (error) return callback(error);

            var env = [
                { name: 'POSTGRESQL_URL', value: `postgres://user${appId}:${password}@postgresql/db${appId}` },
                { name: 'POSTGRESQL_USERNAME', value: `user${appId}` },
                { name: 'POSTGRESQL_PASSWORD', value: password },
                { name: 'POSTGRESQL_HOST', value: 'postgresql' },
                { name: 'POSTGRESQL_PORT', value: '5432' },
                { name: 'POSTGRESQL_DATABASE', value: `db${appId}` }
            ];

            debugApp(app, 'Setting postgresql addon config to %j', env);
            appdb.setAddonConfig(app.id, 'postgresql', env, callback);
        });
    });
}

function teardownPostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    const appId = app.id.replace(/-/g, '');

    var cmd = [ '/addons/postgresql/service.sh', 'remove', appId ];

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

    const appId = app.id.replace(/-/g, '');
    var cmd = [ '/addons/postgresql/service.sh', 'backup', appId ];

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

        const appId = app.id.replace(/-/g, '');
        var cmd = [ '/addons/postgresql/service.sh', 'restore', appId ];

        docker.execContainer('postgresql', cmd, { stdin: input }, callback);
    });
}

function setupMongoDb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up mongodb');

    appdb.getAddonConfigByName(app.id, 'mongodb', 'MONGODB_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        const password = error ? hat(4 * 128) : existingPassword;

        const dbname = app.id;

        var cmd = [ '/addons/mongodb/service.sh', 'add', dbname, password ];

        docker.execContainer('mongodb', cmd, { bufferStdout: true }, function (error) {
            if (error) return callback(error);

            var env = [
                { name: 'MONGODB_URL', value : `mongodb://${dbname}:${password}@mongodb/${dbname}` },
                { name: 'MONGODB_USERNAME', value : dbname },
                { name: 'MONGODB_PASSWORD', value: password },
                { name: 'MONGODB_HOST', value : 'mongodb' },
                { name: 'MONGODB_PORT', value : '27017' },
                { name: 'MONGODB_DATABASE', value : dbname }
            ];

            debugApp(app, 'Setting mongodb addon config to %j', env);
            appdb.setAddonConfig(app.id, 'mongodb', env, callback);
        });
    });
}

function teardownMongoDb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    const dbname = app.id;
    var cmd = [ '/addons/mongodb/service.sh', 'remove', dbname ];

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

    const dbname = app.id;
    var cmd = [ '/addons/mongodb/service.sh', 'backup', dbname ];

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

        const dbname = app.id;
        var cmd = [ '/addons/mongodb/service.sh', 'restore', dbname ];

        docker.execContainer('mongodb', cmd, { stdin: input }, callback);
    });
}

// Ensures that app's addon redis container is running. Can be called when named container already exists/running
function setupRedis(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    appdb.getAddonConfigByName(app.id, 'redis', 'REDIS_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        const redisPassword = error ? hat(4 * 48) : existingPassword; // see box#362 for password length

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
                    --log-driver syslog \
                    --log-opt syslog-address=udp://127.0.0.1:2514 \
                    --log-opt syslog-format=rfc5424 \
                    --log-opt tag="${redisName}" \
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

        shell.sudo('teardownRedis', [ RMAPPDIR_CMD, app.id + '/redis', true /* delete directory */ ], function (error /* ,stdout , stderr*/) {
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
