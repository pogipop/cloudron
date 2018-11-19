'use strict';

exports = module.exports = {
    AddonsError: AddonsError,

    getAddons: getAddons,
    getStatus: getStatus,
    getLogs: getLogs,
    startAddon: startAddon,
    stopAddon: stopAddon,

    startAddons: startAddons,
    updateAddonConfig: updateAddonConfig,

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
    _teardownOauth: teardownOauth,

    ADDON_STATUS_ACTIVE: 'active',
    ADDON_STATUS_INACTIVE: 'inactive'
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
    DockerError = docker.DockerError,
    fs = require('fs'),
    hat = require('./hat.js'),
    infra = require('./infra_version.js'),
    mail = require('./mail.js'),
    mailboxdb = require('./mailboxdb.js'),
    once = require('once'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    rimraf = require('rimraf'),
    safe = require('safetydance'),
    semver = require('semver'),
    shell = require('./shell.js'),
    spawn = require('child_process').spawn,
    split = require('split'),
    request = require('request'),
    util = require('util');

// http://dustinsenos.com/articles/customErrorsInNode
// http://code.google.com/p/v8/wiki/JavaScriptStackTraceApi
function AddonsError(reason, errorOrMessage) {
    assert.strictEqual(typeof reason, 'string');
    assert(errorOrMessage instanceof Error || typeof errorOrMessage === 'string' || typeof errorOrMessage === 'undefined');

    Error.call(this);
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name;
    this.reason = reason;
    if (typeof errorOrMessage === 'undefined') {
        this.message = reason;
    } else if (typeof errorOrMessage === 'string') {
        this.message = errorOrMessage;
    } else {
        this.message = 'Internal error';
        this.nestedError = errorOrMessage;
    }
}
util.inherits(AddonsError, Error);
AddonsError.INTERNAL_ERROR = 'Internal Error';
AddonsError.NOT_FOUND = 'Not Found';

const NOOP = function (app, options, callback) { return callback(); };
const NOOP_CALLBACK = function (error) { if (error) debug(error); };
const RMADDON_CMD = path.join(__dirname, 'scripts/rmaddon.sh');

// setup can be called multiple times for the same app (configure crash restart) and existing data must not be lost
// teardown is destructive. app data stored with the addon is lost
var KNOWN_ADDONS = {
    email: {
        setup: setupEmail,
        teardown: teardownEmail,
        backup: NOOP,
        restore: setupEmail,
        clear: NOOP,
        status: statusEmail
    },
    ldap: {
        setup: setupLdap,
        teardown: teardownLdap,
        backup: NOOP,
        restore: setupLdap,
        clear: NOOP,
        status: null
    },
    localstorage: {
        setup: setupLocalStorage, // docker creates the directory for us
        teardown: teardownLocalStorage,
        backup: NOOP, // no backup because it's already inside app data
        restore: NOOP,
        clear: clearLocalStorage,
        status: null
    },
    mongodb: {
        setup: setupMongoDb,
        teardown: teardownMongoDb,
        backup: backupMongoDb,
        restore: restoreMongoDb,
        clear: clearMongodb,
        status: statusMongoDb
    },
    mysql: {
        setup: setupMySql,
        teardown: teardownMySql,
        backup: backupMySql,
        restore: restoreMySql,
        clear: clearMySql,
        status: statusMySql
    },
    oauth: {
        setup: setupOauth,
        teardown: teardownOauth,
        backup: NOOP,
        restore: setupOauth,
        clear: NOOP,
        status: null
    },
    postgresql: {
        setup: setupPostgreSql,
        teardown: teardownPostgreSql,
        backup: backupPostgreSql,
        restore: restorePostgreSql,
        clear: clearPostgreSql,
        status: statusPostgreSql
    },
    recvmail: {
        setup: setupRecvMail,
        teardown: teardownRecvMail,
        backup: NOOP,
        restore: setupRecvMail,
        clear: NOOP,
        status: null
    },
    redis: {
        setup: setupRedis,
        teardown: teardownRedis,
        backup: backupRedis,
        restore: restoreRedis,
        clear: clearRedis,
        status: null
    },
    sendmail: {
        setup: setupSendMail,
        teardown: teardownSendMail,
        backup: NOOP,
        restore: setupSendMail,
        clear: NOOP,
        status: null
    },
    scheduler: {
        setup: NOOP,
        teardown: NOOP,
        backup: NOOP,
        restore: NOOP,
        clear: NOOP,
        status: null
    },
    docker: {
        setup: NOOP,
        teardown: NOOP,
        backup: NOOP,
        restore: NOOP,
        clear: NOOP,
        status: statusDocker
    }
};

function debugApp(app, args) {
    assert(typeof app === 'object');

    debug((app.fqdn || app.location) + ' ' + util.format.apply(util, Array.prototype.slice.call(arguments, 1)));
}

function parseImageTag(tag) {
    let repository = tag.split(':', 1)[0];
    let version = tag.substr(repository.length + 1).split('@', 1)[0];
    let digest = tag.substr(repository.length + 1 + version.length + 1).split(':', 2)[1];

    return { repository, version: semver.parse(version), digest };
}

function requiresUpgrade(existingTag, currentTag) {
    let etag = parseImageTag(existingTag), ctag = parseImageTag(currentTag);

    return etag.version.major !== ctag.version.major;
}

// paths for dumps
function dumpPath(addon, appId) {
    switch (addon) {
    case 'postgresql': return path.join(paths.APPS_DATA_DIR, appId, 'postgresqldump');
    case 'mysql': return path.join(paths.APPS_DATA_DIR, appId, 'mysqldump');
    case 'mongodb': return path.join(paths.APPS_DATA_DIR, appId, 'mongodbdump');
    case 'redis': return path.join(paths.APPS_DATA_DIR, appId, 'dump.rdb');
    }
}

function getAddons(callback) {
    assert.strictEqual(typeof callback, 'function');

    // we currently list only addons which have a status function to report
    var addons = Object.keys(KNOWN_ADDONS).filter(function (a) { return !!KNOWN_ADDONS[a].status; });

    callback(null, addons);
}

function getStatus(addon, callback) {
    assert.strictEqual(typeof addon, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!KNOWN_ADDONS[addon] || !KNOWN_ADDONS[addon].status) return callback(new AddonsError(AddonsError.NOT_FOUND));

    KNOWN_ADDONS[addon].status(function (error, result) {
        if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

        result.name = addon;

        callback(null, result);
    });
}

function getLogs(addon, options, callback) {
    assert.strictEqual(typeof addon, 'string');
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!KNOWN_ADDONS[addon] || !KNOWN_ADDONS[addon].status) return callback(new AddonsError(AddonsError.NOT_FOUND));

    debug('Getting logs for %s', addon);

    var lines = options.lines || 100,
        format = options.format || 'json',
        follow = !!options.follow;

    assert.strictEqual(typeof lines, 'number');
    assert.strictEqual(typeof format, 'string');

    var args = [ '--lines=' + lines ];
    if (follow) args.push('--follow', '--retry', '--quiet'); // same as -F. to make it work if file doesn't exist, --quiet to not output file headers, which are no logs
    args.push(path.join(paths.LOG_DIR, addon, 'app.log'));

    var cp = spawn('/usr/bin/tail', args);

    var transformStream = split(function mapper(line) {
        if (format !== 'json') return line + '\n';

        var data = line.split(' '); // logs are <ISOtimestamp> <msg>
        var timestamp = (new Date(data[0])).getTime();
        if (isNaN(timestamp)) timestamp = 0;
        var message = line.slice(data[0].length+1);

        // ignore faulty empty logs
        if (!timestamp && !message) return;

        return JSON.stringify({
            realtimeTimestamp: timestamp * 1000,
            message: message,
            source: addon
        }) + '\n';
    });

    transformStream.close = cp.kill.bind(cp, 'SIGKILL'); // closing stream kills the child process

    cp.stdout.pipe(transformStream);

    callback(null, transformStream);
}

function startAddon(addon, callback) {
    assert.strictEqual(typeof addon, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback(new AddonsError(AddonsError.INTERNAL_ERROR, 'not implemented'));
}

function stopAddon(addon, callback) {
    assert.strictEqual(typeof addon, 'string');
    assert.strictEqual(typeof callback, 'function');

    callback(new AddonsError(AddonsError.INTERNAL_ERROR, 'not implemented'));
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

function waitForAddon(containerName, tokenEnvName, callback) {
    assert.strictEqual(typeof containerName, 'string');
    assert.strictEqual(typeof tokenEnvName, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`Waiting for ${containerName}`);

    getAddonDetails(containerName, tokenEnvName, function (error, result) {
        if (error) return callback(error);

        async.retry({ times: 10, interval: 5000 }, function (retryCallback) {
            request.get(`https://${result.ip}:3000/healthcheck?access_token=${result.token}`, { json: true, rejectUnauthorized: false }, function (error, response) {
                if (error) return retryCallback(new Error(`Error waiting for ${containerName}: ${error.message}`));
                if (response.statusCode !== 200 || !response.body.status) return retryCallback(new Error(`Error waiting for ${containerName}. Status code: ${response.statusCode} message: ${response.body.message}`));

                retryCallback(null);
            });
        }, callback);
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

function importAppDatabase(app, addon, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof addon, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!(addon in KNOWN_ADDONS)) return callback(new Error(`No such addon: ${addon}`));

    async.series([
        KNOWN_ADDONS[addon].setup.bind(null, app, app.manifest.addons[addon]),
        KNOWN_ADDONS[addon].clear.bind(null, app, app.manifest.addons[addon]), // clear in case we crashed in a restore
        KNOWN_ADDONS[addon].restore.bind(null, app, app.manifest.addons[addon])
    ], callback);
}

function importDatabase(addon, callback) {
    assert.strictEqual(typeof addon, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`importDatabase: Importing ${addon}`);

    appdb.getAll(function (error, apps) {
        if (error) return callback(error);

        async.eachSeries(apps, function iterator (app, iteratorCallback) {
            if (!(addon in app.manifest.addons)) return iteratorCallback(); // app doesn't use the addon

            debug(`importDatabase: Importing addon ${addon} of app ${app.id}`);

            importAppDatabase(app, addon, function (error) {
                if (!error) return iteratorCallback();

                debug(`importDatabase: Error importing ${addon} of app ${app.id}. Marking as errored`, error);
                appdb.update(app.id, { installationState: appdb.ISTATE_ERROR, installationProgress: error.message }, iteratorCallback);
            });
        }, callback);
    });
}

function updateAddonConfig(platformConfig, callback) {
    callback = callback || NOOP_CALLBACK;

    // TODO: maybe derive these defaults based on how many apps are using them
    const defaultMemoryLimits = {
        mysql: (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 256 * 1024 * 1024,
        mongodb: (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 200 * 1024 * 1024,
        postgresql: (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 256 * 1024 * 1024,
        mail: Math.max((1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 128, 256) * 1024 * 1024
    };

    debug('updateAddonConfig: %j', platformConfig);

    // TODO: this should possibly also rollback memory to default
    async.eachSeries([ 'mysql', 'postgresql', 'mail', 'mongodb' ], function iterator(containerName, iteratorCallback) {
        const containerConfig = platformConfig[containerName];
        let memory, memorySwap;
        if (containerConfig && containerConfig.memory && containerConfig.memorySwap) {
            memory = containerConfig.memory;
            memorySwap = containerConfig.memorySwap;
        } else {
            memory = defaultMemoryLimits[containerName];
            memorySwap = memory * 2;
        }

        const args = `update --memory ${memory} --memory-swap ${memorySwap} ${containerName}`.split(' ');
        shell.spawn(`update${containerName}`, '/usr/bin/docker', args, { }, iteratorCallback);
    }, callback);
}

function startAddons(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    let startFuncs = [ ];

    // always start addons on any infra change, regardless of minor or major update
    if (existingInfra.version !== infra.version) {
        debug(`startAddons: ${existingInfra.version} -> ${infra.version}. starting all addons`);
        startFuncs.push(
            startMysql.bind(null, existingInfra),
            startPostgresql.bind(null, existingInfra),
            startMongodb.bind(null, existingInfra),
            startRedis.bind(null, existingInfra),
            mail.startMail);
    } else {
        assert.strictEqual(typeof existingInfra.images, 'object');

        if (infra.images.mysql.tag !== existingInfra.images.mysql.tag) startFuncs.push(startMysql.bind(null, existingInfra));
        if (infra.images.postgresql.tag !== existingInfra.images.postgresql.tag) startFuncs.push(startPostgresql.bind(null, existingInfra));
        if (infra.images.mongodb.tag !== existingInfra.images.mongodb.tag) startFuncs.push(startMongodb.bind(null, existingInfra));
        if (infra.images.mail.tag !== existingInfra.images.mail.tag) startFuncs.push(mail.startMail);
        if (infra.images.redis.tag !== existingInfra.images.redis.tag) startFuncs.push(startRedis.bind(null, existingInfra));

        debug('startAddons: existing infra. incremental addon create %j', startFuncs.map(function (f) { return f.name; }));
    }

    async.series(startFuncs, callback);
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

function statusEmail(callback) {
    assert.strictEqual(typeof callback, 'function');

    docker.inspect('mail', function (error, result) {
        if (error && error.reason === DockerError.NOT_FOUND) return callback(null, { status: exports.ADDON_STATUS_INACTIVE });
        if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

        callback(null, { status: result.State.Running ? exports.ADDON_STATUS_ACTIVE : exports.ADDON_STATUS_INACTIVE });
    });
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

function startMysql(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    const tag = infra.images.mysql.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;
    const rootPassword = hat(8 * 128);
    const cloudronToken = hat(8 * 128);
    const memoryLimit = 4 * 256;

    const upgrading = existingInfra.version !== 'none' && requiresUpgrade(existingInfra.images.mysql.tag, tag);

    if (upgrading) {
        debug('startMysql: mysql will be upgraded');
        shell.sudoSync('startMysql', `${RMADDON_CMD} mysql`);
    }

    const cmd = `docker run --restart=always -d --name="mysql" \
                --net cloudron \
                --net-alias mysql \
                --log-driver syslog \
                --log-opt syslog-address=udp://127.0.0.1:2514 \
                --log-opt syslog-format=rfc5424 \
                --log-opt tag=mysql \
                -m ${memoryLimit}m \
                --memory-swap ${memoryLimit * 2}m \
                --dns 172.18.0.1 \
                --dns-search=. \
                -e CLOUDRON_MYSQL_TOKEN=${cloudronToken} \
                -e CLOUDRON_MYSQL_ROOT_HOST=172.18.0.1 \
                -e CLOUDRON_MYSQL_ROOT_PASSWORD=${rootPassword} \
                -v "${dataDir}/mysql:/var/lib/mysql" \
                --label isCloudronManaged=true \
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startMysql', cmd);

    waitForAddon('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error) {
        if (error) return callback(error);
        if (!upgrading) return callback(null);

        importDatabase('mysql', callback);
    });
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
                if (response.statusCode !== 201) return callback(new Error(`Error setting up mysql. Status code: ${response.statusCode} message: ${response.body.message}`));

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
            if (response.statusCode !== 200) return callback(new Error(`Error clearing mysql. Status code: ${response.statusCode} message: ${response.body.message}`));
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
            if (response.statusCode !== 200) return callback(new Error(`Error clearing mysql. Status code: ${response.statusCode} message: ${response.body.message}`));

            appdb.unsetAddonConfig(app.id, 'mysql', callback);
        });
    });
}

function pipeRequestToFile(url, filename, callback) {
    assert.strictEqual(typeof url, 'string');
    assert.strictEqual(typeof filename, 'string');
    assert.strictEqual(typeof callback, 'function');

    const writeStream = fs.createWriteStream(filename);

    const done = once(function (error) { // the writeStream and the request can both error
        if (error) writeStream.close();
        callback(error);
    });

    writeStream.on('error', done);
    writeStream.on('open', function () {
        // note: do not attach to post callback handler because this will buffer the entire reponse!
        // see https://github.com/request/request/issues/2270
        const req = request.post(url, { rejectUnauthorized: false });
        req.on('error', done); // network error, dns error, request errored in middle etc
        req.on('response', function (response) {
            if (response.statusCode !== 200) return done(new Error(`Unexpected response code: ${response.statusCode} message: ${response.statusMessage} filename: ${filename}`));

            response.pipe(writeStream).on('finish', done); // this is hit after data written to disk
        });
    });
}

function backupMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    const database = mysqlDatabaseName(app.id);

    debugApp(app, 'Backing up mysql');

    getAddonDetails('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error, result) {
        if (error) return callback(error);

        const url = `https://${result.ip}:3000/` + (options.multipleDatabases ? 'prefixes' : 'databases') + `/${database}/backup?access_token=${result.token}`;
        pipeRequestToFile(url, dumpPath('mysql', app.id), callback);
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

        var input = fs.createReadStream(dumpPath('mysql', app.id));
        input.on('error', callback);

        const restoreReq = request.post(`https://${result.ip}:3000/` + (options.multipleDatabases ? 'prefixes' : 'databases') + `/${database}/restore?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(error);
            if (response.statusCode !== 200) return callback(new Error(`Unexpected response from mysql addon ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });

        input.pipe(restoreReq);
    });
}

function statusMySql(callback) {
    assert.strictEqual(typeof callback, 'function');

    docker.inspect('mysql', function (error, result) {
        if (error && error.reason === DockerError.NOT_FOUND) return callback(null, { status: exports.ADDON_STATUS_INACTIVE });
        if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

        callback(null, { status: result.State.Running ? exports.ADDON_STATUS_ACTIVE : exports.ADDON_STATUS_INACTIVE });
    });
}

function postgreSqlNames(appId) {
    appId = appId.replace(/-/g, '');
    return { database: `db${appId}`, username: `user${appId}` };
}

function startPostgresql(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    const tag = infra.images.postgresql.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;
    const rootPassword = hat(8 * 128);
    const cloudronToken = hat(8 * 128);
    const memoryLimit = 4 * 256;

    const upgrading = existingInfra.version !== 'none' && requiresUpgrade(existingInfra.images.postgresql.tag, tag);

    if (upgrading) {
        debug('startPostgresql: postgresql will be upgraded');
        shell.sudoSync('startPostgresql', `${RMADDON_CMD} postgresql`);
    }

    const cmd = `docker run --restart=always -d --name="postgresql" \
                --net cloudron \
                --net-alias postgresql \
                --log-driver syslog \
                --log-opt syslog-address=udp://127.0.0.1:2514 \
                --log-opt syslog-format=rfc5424 \
                --log-opt tag=postgresql \
                -m ${memoryLimit}m \
                --memory-swap ${memoryLimit * 2}m \
                --dns 172.18.0.1 \
                --dns-search=. \
                -e CLOUDRON_POSTGRESQL_ROOT_PASSWORD="${rootPassword}" \
                -e CLOUDRON_POSTGRESQL_TOKEN="${cloudronToken}" \
                -v "${dataDir}/postgresql:/var/lib/postgresql" \
                --label isCloudronManaged=true \
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startPostgresql', cmd);

    waitForAddon('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error) {
        if (error) return callback(error);
        if (!upgrading) return callback(null);

        importDatabase('postgresql', callback);
    });
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

    getAddonDetails('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error, result) {
        if (error) return callback(error);

        const url = `https://${result.ip}:3000/databases/${database}/backup?access_token=${result.token}`;
        pipeRequestToFile(url, dumpPath('postgresql', app.id), callback);
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

        var input = fs.createReadStream(dumpPath('postgresql', app.id));
        input.on('error', callback);

        const restoreReq = request.post(`https://${result.ip}:3000/databases/${database}/restore?access_token=${result.token}&username=${username}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(error);
            if (response.statusCode !== 200) return callback(new Error(`Unexpected response from postgresql addon ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });

        input.pipe(restoreReq);
    });
}

function statusPostgreSql(callback) {
    assert.strictEqual(typeof callback, 'function');

    docker.inspect('postgresql', function (error, result) {
        if (error && error.reason === DockerError.NOT_FOUND) return callback(null, { status: exports.ADDON_STATUS_INACTIVE });
        if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

        callback(null, { status: result.State.Running ? exports.ADDON_STATUS_ACTIVE : exports.ADDON_STATUS_INACTIVE });
    });
}

function startMongodb(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    const tag = infra.images.mongodb.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;
    const rootPassword = hat(8 * 128);
    const cloudronToken = hat(8 * 128);
    const memoryLimit = 4 * 256;

    const upgrading = existingInfra.version !== 'none' && requiresUpgrade(existingInfra.images.mongodb.tag, tag);

    if (upgrading) {
        debug('startMongodb: mongodb will be upgraded');
        shell.sudoSync('startMongodb', `${RMADDON_CMD} mongodb`);
    }

    const cmd = `docker run --restart=always -d --name="mongodb" \
                --net cloudron \
                --net-alias mongodb \
                --log-driver syslog \
                --log-opt syslog-address=udp://127.0.0.1:2514 \
                --log-opt syslog-format=rfc5424 \
                --log-opt tag=mongodb \
                -m ${memoryLimit}m \
                --memory-swap ${memoryLimit * 2}m \
                --dns 172.18.0.1 \
                --dns-search=. \
                -e CLOUDRON_MONGODB_ROOT_PASSWORD="${rootPassword}" \
                -e CLOUDRON_MONGODB_TOKEN="${cloudronToken}" \
                -v "${dataDir}/mongodb:/var/lib/mongodb" \
                --label isCloudronManaged=true \
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startMongodb', cmd);

    waitForAddon('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error) {
        if (error) return callback(error);
        if (!upgrading) return callback(null);

        importDatabase('mongodb', callback);
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
                    { name: 'MONGODB_URL', value : `mongodb://${data.username}:${data.password}@mongodb/${data.database}` },
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

    getAddonDetails('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error, result) {
        if (error) return callback(error);

        const url = `https://${result.ip}:3000/databases/${app.id}/backup?access_token=${result.token}`;
        pipeRequestToFile(url, dumpPath('mongodb', app.id), callback);
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

        const readStream = fs.createReadStream(dumpPath('mongodb', app.id));
        readStream.on('error', callback);

        const restoreReq = request.post(`https://${result.ip}:3000/databases/${app.id}/restore?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(error);
            if (response.statusCode !== 200) return callback(new Error(`Unexpected response from mongodb addon ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });

        readStream.pipe(restoreReq);
    });
}

function statusMongoDb(callback) {
    assert.strictEqual(typeof callback, 'function');

    docker.inspect('mongodb', function (error, result) {
        if (error && error.reason === DockerError.NOT_FOUND) return callback(null, { status: exports.ADDON_STATUS_INACTIVE });
        if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

        callback(null, { status: result.State.Running ? exports.ADDON_STATUS_ACTIVE : exports.ADDON_STATUS_INACTIVE });
    });
}

function startRedis(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    const tag = infra.images.redis.tag;
    const upgrading = existingInfra.version !== 'none' && requiresUpgrade(existingInfra.images.redis.tag, tag);

    if (!upgrading) return callback();

    importDatabase('redis', callback); // setupRedis currently starts the app container
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
                        --label isCloudronManaged=true \
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
                waitForAddon.bind(null, 'redis-' + app.id, 'CLOUDRON_REDIS_TOKEN')
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

        shell.sudo('removeVolume', [ RMADDON_CMD, 'redis', app.id ], function (error) {
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

    getAddonDetails('redis-' + app.id, 'CLOUDRON_REDIS_TOKEN', function (error, result) {
        if (error) return callback(error);

        const url = `https://${result.ip}:3000/backup?access_token=${result.token}`;
        pipeRequestToFile(url, dumpPath('redis', app.id), callback);
    });
}

function restoreRedis(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Restoring redis');

    getAddonDetails('redis-' + app.id, 'CLOUDRON_REDIS_TOKEN', function (error, result) {
        if (error) return callback(error);

        let input;
        const newDumpLocation = dumpPath('redis', app.id);
        if (fs.existsSync(newDumpLocation)) {
            input = fs.createReadStream(newDumpLocation);
        } else { // old location of dumps
            input = fs.createReadStream(path.join(paths.APPS_DATA_DIR, app.id, 'redis/dump.rdb'));
        }
        input.on('error', callback);

        const restoreReq = request.post(`https://${result.ip}:3000/restore?access_token=${result.token}`, { rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(error);
            if (response.statusCode !== 200) return callback(new Error(`Unexpected response from redis addon: ${response.statusCode} message: ${response.body.message}`));

            callback(null);
        });

        input.pipe(restoreReq);
    });
}

function statusDocker(callback) {
    assert.strictEqual(typeof callback, 'function');

    docker.ping(function (error) {
        callback(null, { status: error ? exports.ADDON_STATUS_INACTIVE: exports.ADDON_STATUS_ACTIVE });
    });
}
