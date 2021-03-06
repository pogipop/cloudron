'use strict';

exports = module.exports = {
    AddonsError: AddonsError,

    getServices: getServices,
    getService: getService,
    configureService: configureService,
    getServiceLogs: getServiceLogs,
    restartService: restartService,

    startServices: startServices,
    updateServiceConfig: updateServiceConfig,

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

    SERVICE_STATUS_STARTING: 'starting',  // container up, waiting for healthcheck
    SERVICE_STATUS_ACTIVE: 'active',
    SERVICE_STATUS_STOPPED: 'stopped'
};

var accesscontrol = require('./accesscontrol.js'),
    appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    clients = require('./clients.js'),
    constants = require('./constants.js'),
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
    once = require('once'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    rimraf = require('rimraf'),
    safe = require('safetydance'),
    semver = require('semver'),
    settings = require('./settings.js'),
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
AddonsError.NOT_ACTIVE = 'Not Active';

const NOOP = function (app, options, callback) { return callback(); };
const NOOP_CALLBACK = function (error) { if (error) debug(error); };
const RMADDONDIR_CMD = path.join(__dirname, 'scripts/rmaddondir.sh');

// setup can be called multiple times for the same app (configure crash restart) and existing data must not be lost
// teardown is destructive. app data stored with the addon is lost
var KNOWN_ADDONS = {
    email: {
        setup: setupEmail,
        teardown: teardownEmail,
        backup: NOOP,
        restore: setupEmail,
        clear: NOOP,
    },
    ldap: {
        setup: setupLdap,
        teardown: teardownLdap,
        backup: NOOP,
        restore: setupLdap,
        clear: NOOP,
    },
    localstorage: {
        setup: setupLocalStorage,
        teardown: teardownLocalStorage,
        backup: NOOP, // no backup because it's already inside app data
        restore: NOOP,
        clear: clearLocalStorage,
    },
    mongodb: {
        setup: setupMongoDb,
        teardown: teardownMongoDb,
        backup: backupMongoDb,
        restore: restoreMongoDb,
        clear: clearMongodb,
    },
    mysql: {
        setup: setupMySql,
        teardown: teardownMySql,
        backup: backupMySql,
        restore: restoreMySql,
        clear: clearMySql,
    },
    oauth: {
        setup: setupOauth,
        teardown: teardownOauth,
        backup: NOOP,
        restore: setupOauth,
        clear: NOOP,
    },
    postgresql: {
        setup: setupPostgreSql,
        teardown: teardownPostgreSql,
        backup: backupPostgreSql,
        restore: restorePostgreSql,
        clear: clearPostgreSql,
    },
    recvmail: {
        setup: setupRecvMail,
        teardown: teardownRecvMail,
        backup: NOOP,
        restore: setupRecvMail,
        clear: NOOP,
    },
    redis: {
        setup: setupRedis,
        teardown: teardownRedis,
        backup: backupRedis,
        restore: restoreRedis,
        clear: clearRedis,
    },
    sendmail: {
        setup: setupSendMail,
        teardown: teardownSendMail,
        backup: NOOP,
        restore: setupSendMail,
        clear: NOOP,
    },
    scheduler: {
        setup: NOOP,
        teardown: NOOP,
        backup: NOOP,
        restore: NOOP,
        clear: NOOP,
    },
    docker: {
        setup: NOOP,
        teardown: NOOP,
        backup: NOOP,
        restore: NOOP,
        clear: NOOP,
    }
};

const KNOWN_SERVICES = {
    mail: {
        status: containerStatus.bind(null, 'mail', 'CLOUDRON_MAIL_TOKEN'),
        restart: mail.restartMail,
        defaultMemoryLimit: Math.max((1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 128, 256) * 1024 * 1024
    },
    mongodb: {
        status: containerStatus.bind(null, 'mongodb', 'CLOUDRON_MONGODB_TOKEN'),
        restart: restartContainer.bind(null, 'mongodb'),
        defaultMemoryLimit: (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 200 * 1024 * 1024
    },
    mysql: {
        status: containerStatus.bind(null, 'mysql', 'CLOUDRON_MYSQL_TOKEN'),
        restart: restartContainer.bind(null, 'mysql'),
        defaultMemoryLimit: (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 256 * 1024 * 1024
    },
    postgresql: {
        status: containerStatus.bind(null, 'postgresql', 'CLOUDRON_POSTGRESQL_TOKEN'),
        restart: restartContainer.bind(null, 'postgresql'),
        defaultMemoryLimit: (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 256 * 1024 * 1024
    },
    docker: {
        status: statusDocker,
        restart: restartDocker,
        defaultMemoryLimit: 0
    },
    unbound: {
        status: statusUnbound,
        restart: restartUnbound,
        defaultMemoryLimit: 0
    },
    sftp: {
        status: statusSftp,
        restart: restartContainer.bind(null, 'sftp'),
        defaultMemoryLimit: 256 * 1024 * 1024
    },
    graphite: {
        status: statusGraphite,
        restart: restartContainer.bind(null, 'graphite'),
        defaultMemoryLimit: 75 * 1024 * 1024
    },
    nginx: {
        status: statusNginx,
        restart: restartNginx,
        defaultMemoryLimit: 0
    }
};

function debugApp(app /*, args */) {
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

function restartContainer(serviceName, callback) {
    assert.strictEqual(typeof serviceName, 'string');
    assert.strictEqual(typeof callback, 'function');

    assert(KNOWN_SERVICES[serviceName], `Unknown service ${serviceName}`);

    docker.stopContainer(serviceName, function (error) {
        if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

        docker.startContainer(serviceName, function (error) {
            if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

            callback(null);
        });
    });
}

function getServiceDetails(containerName, tokenEnvName, callback) {
    assert.strictEqual(typeof containerName, 'string');
    assert.strictEqual(typeof tokenEnvName, 'string');
    assert.strictEqual(typeof callback, 'function');

    docker.inspect(containerName, function (error, result) {
        if (error && error.reason === DockerError.NOT_FOUND) return callback(new AddonsError(AddonsError.NOT_ACTIVE, error));
        if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

        const ip = safe.query(result, 'NetworkSettings.Networks.cloudron.IPAddress', null);
        if (!ip) return callback(new AddonsError(AddonsError.NOT_ACTIVE, `Error getting ${containerName} container ip`));

        // extract the cloudron token for auth
        const env = safe.query(result, 'Config.Env', null);
        if (!env) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, `Error getting ${containerName} env`));
        const tmp = env.find(function (e) { return e.indexOf(tokenEnvName) === 0; });
        if (!tmp) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, `Error getting ${containerName} cloudron token env var`));
        const token = tmp.slice(tokenEnvName.length + 1); // +1 for the = sign
        if (!token)  return callback(new AddonsError(AddonsError.INTERNAL_ERROR, `Error getting ${containerName} cloudron token`));

        callback(null, { ip: ip, token: token, state: result.State });
    });
}

function containerStatus(addonName, addonTokenName, callback) {
    assert.strictEqual(typeof addonName, 'string');
    assert.strictEqual(typeof addonTokenName, 'string');
    assert.strictEqual(typeof callback, 'function');

    getServiceDetails(addonName, addonTokenName, function (error, addonDetails) {
        if (error && error.reason === AddonsError.NOT_ACTIVE) return callback(null, { status: exports.SERVICE_STATUS_STOPPED });
        if (error) return callback(error);

        request.get(`https://${addonDetails.ip}:3000/healthcheck?access_token=${addonDetails.token}`, { json: true, rejectUnauthorized: false }, function (error, response) {
            if (error) return callback(null, { status: exports.SERVICE_STATUS_STARTING, error: `Error waiting for ${addonName}: ${error.message}` });
            if (response.statusCode !== 200 || !response.body.status) return callback(null, { status: exports.SERVICE_STATUS_STARTING, error: `Error waiting for ${addonName}. Status code: ${response.statusCode} message: ${response.body.message}` });

            docker.memoryUsage(addonName, function (error, result) {
                if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

                var tmp = {
                    status: addonDetails.state.Running ? exports.SERVICE_STATUS_ACTIVE : exports.SERVICE_STATUS_STOPPED,
                    memoryUsed: result.memory_stats.usage,
                    memoryPercent: parseInt(100 * result.memory_stats.usage / result.memory_stats.limit)
                };

                callback(null, tmp);
            });
        });
    });
}

function getServices(callback) {
    assert.strictEqual(typeof callback, 'function');

    let services = Object.keys(KNOWN_SERVICES);

    callback(null, services);
}

function getService(serviceName, callback) {
    assert.strictEqual(typeof serviceName, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!KNOWN_SERVICES[serviceName]) return callback(new AddonsError(AddonsError.NOT_FOUND));

    var tmp = {
        name: serviceName,
        status: null,
        config: {
            // If a property is not set then we cannot change it through the api, see below
            // memory: 0,
            // memorySwap: 0
        }
    };

    settings.getPlatformConfig(function (error, platformConfig) {
        if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

        if (platformConfig[serviceName] && platformConfig[serviceName].memory && platformConfig[serviceName].memorySwap) {
            tmp.config.memory = platformConfig[serviceName].memory;
            tmp.config.memorySwap = platformConfig[serviceName].memorySwap;
        } else if (KNOWN_SERVICES[serviceName].defaultMemoryLimit) {
            tmp.config.memory = KNOWN_SERVICES[serviceName].defaultMemoryLimit;
            tmp.config.memorySwap = tmp.config.memory * 2;
        }

        KNOWN_SERVICES[serviceName].status(function (error, result) {
            if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

            tmp.status = result.status;
            tmp.memoryUsed = result.memoryUsed;
            tmp.memoryPercent = result.memoryPercent;
            tmp.error = result.error || null;

            callback(null, tmp);
        });
    });
}

function configureService(serviceName, data, callback) {
    assert.strictEqual(typeof serviceName, 'string');
    assert.strictEqual(typeof data, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!KNOWN_SERVICES[serviceName]) return callback(new AddonsError(AddonsError.NOT_FOUND));

    settings.getPlatformConfig(function (error, platformConfig) {
        if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

        if (!platformConfig[serviceName]) platformConfig[serviceName] = {};

        // if not specified we clear the entry and use defaults
        if (!data.memory || !data.memorySwap) {
            delete platformConfig[serviceName];
        } else {
            platformConfig[serviceName].memory = data.memory;
            platformConfig[serviceName].memorySwap = data.memorySwap;
        }

        settings.setPlatformConfig(platformConfig, function (error) {
            if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

            callback(null);
        });
    });
}

function getServiceLogs(serviceName, options, callback) {
    assert.strictEqual(typeof serviceName, 'string');
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    assert.strictEqual(typeof options.lines, 'number');
    assert.strictEqual(typeof options.format, 'string');
    assert.strictEqual(typeof options.follow, 'boolean');

    if (!KNOWN_SERVICES[serviceName]) return callback(new AddonsError(AddonsError.NOT_FOUND));

    debug(`Getting logs for ${serviceName}`);

    var lines = options.lines,
        format = options.format || 'json',
        follow = options.follow;

    let cmd, args = [];

    // docker and unbound use journald
    if (serviceName === 'docker' || serviceName === 'unbound') {
        cmd = 'journalctl';

        args.push('--lines=' + (lines === -1 ? 'all' : lines));
        args.push(`--unit=${serviceName}`);
        args.push('--no-pager');
        args.push('--output=short-iso');

        if (follow) args.push('--follow');
    } else {
        cmd = '/usr/bin/tail';

        args.push('--lines=' + (lines === -1 ? '+1' : lines));
        if (follow) args.push('--follow', '--retry', '--quiet'); // same as -F. to make it work if file doesn't exist, --quiet to not output file headers, which are no logs
        args.push(path.join(paths.LOG_DIR, serviceName, 'app.log'));
    }

    var cp = spawn(cmd, args);

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
            source: serviceName
        }) + '\n';
    });

    transformStream.close = cp.kill.bind(cp, 'SIGKILL'); // closing stream kills the child process

    cp.stdout.pipe(transformStream);

    callback(null, transformStream);
}

function restartService(serviceName, callback) {
    assert.strictEqual(typeof serviceName, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!KNOWN_SERVICES[serviceName]) return callback(new AddonsError(AddonsError.NOT_FOUND));

    KNOWN_SERVICES[serviceName].restart(callback);
}

function waitForService(containerName, tokenEnvName, callback) {
    assert.strictEqual(typeof containerName, 'string');
    assert.strictEqual(typeof tokenEnvName, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`Waiting for ${containerName}`);

    getServiceDetails(containerName, tokenEnvName, function (error, result) {
        if (error) return callback(error);

        async.retry({ times: 10, interval: 15000 }, function (retryCallback) {
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

function updateServiceConfig(platformConfig, callback) {
    callback = callback || NOOP_CALLBACK;

    debug('updateServiceConfig: %j', platformConfig);

    // TODO: this should possibly also rollback memory to default
    async.eachSeries([ 'mysql', 'postgresql', 'mail', 'mongodb', 'graphite' ], function iterator(serviceName, iteratorCallback) {
        const containerConfig = platformConfig[serviceName];
        let memory, memorySwap;
        if (containerConfig && containerConfig.memory && containerConfig.memorySwap) {
            memory = containerConfig.memory;
            memorySwap = containerConfig.memorySwap;
        } else {
            memory = KNOWN_SERVICES[serviceName].defaultMemoryLimit;
            memorySwap = memory * 2;
        }

        const args = `update --memory ${memory} --memory-swap ${memorySwap} ${serviceName}`.split(' ');
        shell.spawn(`update${serviceName}`, '/usr/bin/docker', args, { }, iteratorCallback);
    }, callback);
}

function startServices(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    let startFuncs = [ ];

    // always start addons on any infra change, regardless of minor or major update
    if (existingInfra.version !== infra.version) {
        debug(`startServices: ${existingInfra.version} -> ${infra.version}. starting all services`);
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

        debug('startServices: existing infra. incremental service create %j', startFuncs.map(function (f) { return f.name; }));
    }

    async.series(startFuncs, callback);
}

function getEnvironment(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    appdb.getAddonConfigByAppId(app.id, function (error, result) {
        if (error) return callback(error);

        if (app.manifest.addons['docker']) result.push({ name: 'DOCKER_HOST', value: `tcp://172.18.0.1:${constants.DOCKER_PROXY_PORT}` });

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

    const volumeDataDir = apps.getDataDir(app, app.dataDir);

    // reomve any existing volume in case it's bound with an old dataDir
    async.series([
        docker.removeVolume.bind(null, app, `${app.id}-localstorage`),
        docker.createVolume.bind(null, app, `${app.id}-localstorage`, volumeDataDir)
    ], callback);
}

function clearLocalStorage(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'clearLocalStorage');

    docker.clearVolume(app, `${app.id}-localstorage`, { removeDirectory: false }, callback);
}

function teardownLocalStorage(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'teardownLocalStorage');

    async.series([
        docker.clearVolume.bind(null, app, `${app.id}-localstorage`, { removeDirectory: true }),
        docker.removeVolume.bind(null, app, `${app.id}-localstorage`)
    ], callback);
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

            const envPrefix = app.manifest.manifestVersion <= 1 ? '' : 'CLOUDRON_';

            var env = [
                { name: `${envPrefix}OAUTH_CLIENT_ID`, value: result.id },
                { name: `${envPrefix}OAUTH_CLIENT_SECRET`, value: result.clientSecret },
                { name: `${envPrefix}OAUTH_ORIGIN`, value: settings.adminOrigin() }
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

        const envPrefix = app.manifest.manifestVersion <= 1 ? '' : 'CLOUDRON_';

        // note that "external" access info can be derived from MAIL_DOMAIN (since it's part of user documentation)
        var env = [
            { name: `${envPrefix}MAIL_SMTP_SERVER`, value: 'mail' },
            { name: `${envPrefix}MAIL_SMTP_PORT`, value: '2525' },
            { name: `${envPrefix}MAIL_IMAP_SERVER`, value: 'mail' },
            { name: `${envPrefix}MAIL_IMAP_PORT`, value: '9993' },
            { name: `${envPrefix}MAIL_SIEVE_SERVER`, value: 'mail' },
            { name: `${envPrefix}MAIL_SIEVE_PORT`, value: '4190' },
            { name: `${envPrefix}MAIL_DOMAIN`, value: app.domain },
            { name: `${envPrefix}MAIL_DOMAINS`, value: mailInDomains },
            { name: `${envPrefix}LDAP_MAILBOXES_BASE_DN`, value: 'ou=mailboxes,dc=cloudron' }
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

    const envPrefix = app.manifest.manifestVersion <= 1 ? '' : 'CLOUDRON_';

    var env = [
        { name: `${envPrefix}LDAP_SERVER`, value: '172.18.0.1' },
        { name: `${envPrefix}LDAP_PORT`, value: '' + constants.LDAP_PORT },
        { name: `${envPrefix}LDAP_URL`, value: 'ldap://172.18.0.1:' + constants.LDAP_PORT },
        { name: `${envPrefix}LDAP_USERS_BASE_DN`, value: 'ou=users,dc=cloudron' },
        { name: `${envPrefix}LDAP_GROUPS_BASE_DN`, value: 'ou=groups,dc=cloudron' },
        { name: `${envPrefix}LDAP_BIND_DN`, value: 'cn='+ app.id + ',ou=apps,dc=cloudron' },
        { name: `${envPrefix}LDAP_BIND_PASSWORD`, value: hat(4 * 128) } // this is ignored
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

    appdb.getAddonConfigByName(app.id, 'sendmail', '%MAIL_SMTP_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        var password = error ? hat(4 * 48) : existingPassword; // see box#565 for password length

        const envPrefix = app.manifest.manifestVersion <= 1 ? '' : 'CLOUDRON_';

        var env = [
            { name: `${envPrefix}MAIL_SMTP_SERVER`, value: 'mail' },
            { name: `${envPrefix}MAIL_SMTP_PORT`, value: '2525' },
            { name: `${envPrefix}MAIL_SMTPS_PORT`, value: '2465' },
            { name: `${envPrefix}MAIL_SMTP_USERNAME`, value: app.mailboxName + '@' + app.domain },
            { name: `${envPrefix}MAIL_SMTP_PASSWORD`, value: password },
            { name: `${envPrefix}MAIL_FROM`, value: app.mailboxName + '@' + app.domain },
            { name: `${envPrefix}MAIL_DOMAIN`, value: app.domain }
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

    appdb.getAddonConfigByName(app.id, 'recvmail', '%MAIL_IMAP_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        var password = error ? hat(4 * 48) : existingPassword;  // see box#565 for password length

        const envPrefix = app.manifest.manifestVersion <= 1 ? '' : 'CLOUDRON_';

        var env = [
            { name: `${envPrefix}MAIL_IMAP_SERVER`, value: 'mail' },
            { name: `${envPrefix}MAIL_IMAP_PORT`, value: '9993' },
            { name: `${envPrefix}MAIL_IMAP_USERNAME`, value: app.mailboxName + '@' + app.domain },
            { name: `${envPrefix}MAIL_IMAP_PASSWORD`, value: password },
            { name: `${envPrefix}MAIL_TO`, value: app.mailboxName + '@' + app.domain },
            { name: `${envPrefix}MAIL_DOMAIN`, value: app.domain }
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

    if (upgrading) debug('startMysql: mysql will be upgraded');
    const upgradeFunc = upgrading ? shell.sudo.bind(null, 'startMysql', [ RMADDONDIR_CMD, 'mysql' ], {}) : (next) => next();

    upgradeFunc(function (error) {
        if (error) return callback(error);

        const cmd = `docker run --restart=always -d --name="mysql" \
                    --hostname mysql \
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

        shell.exec('startMysql', cmd, function (error) {
            if (error) return callback(error);

            waitForService('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error) {
                if (error) return callback(error);
                if (!upgrading) return callback(null);

                importDatabase('mysql', callback);
            });
        });
    });
}

function setupMySql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up mysql');

    appdb.getAddonConfigByName(app.id, 'mysql', '%MYSQL_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        const tmp = mysqlDatabaseName(app.id);

        const data = {
            database: tmp,
            prefix: tmp,
            username: tmp,
            password: error ? hat(4 * 48) : existingPassword // see box#362 for password length
        };

        getServiceDetails('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error, result) {
            if (error) return callback(error);

            request.post(`https://${result.ip}:3000/` + (options.multipleDatabases ? 'prefixes' : 'databases') + `?access_token=${result.token}`, { rejectUnauthorized: false, json: data }, function (error, response) {
                if (error) return callback(new Error('Error setting up mysql: ' + error));
                if (response.statusCode !== 201) return callback(new Error(`Error setting up mysql. Status code: ${response.statusCode} message: ${response.body.message}`));

                const envPrefix = app.manifest.manifestVersion <= 1 ? '' : 'CLOUDRON_';

                var env = [
                    { name: `${envPrefix}MYSQL_USERNAME`, value: data.username },
                    { name: `${envPrefix}MYSQL_PASSWORD`, value: data.password },
                    { name: `${envPrefix}MYSQL_HOST`, value: 'mysql' },
                    { name: `${envPrefix}MYSQL_PORT`, value: '3306' }
                ];

                if (options.multipleDatabases) {
                    env = env.concat({ name: `${envPrefix}MYSQL_DATABASE_PREFIX`, value: `${data.prefix}_` });
                } else {
                    env = env.concat(
                        { name: `${envPrefix}MYSQL_URL`, value: `mysql://${data.username}:${data.password}@mysql/${data.database}` },
                        { name: `${envPrefix}MYSQL_DATABASE`, value: data.database }
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

    getServiceDetails('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error, result) {
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

    getServiceDetails('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error, result) {
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

    getServiceDetails('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error, result) {
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

    getServiceDetails('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error, result) {
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

    if (upgrading) debug('startPostgresql: postgresql will be upgraded');
    const upgradeFunc = upgrading ? shell.sudo.bind(null, 'startPostgresql', [ RMADDONDIR_CMD, 'postgresql' ], {}) : (next) => next();

    upgradeFunc(function (error) {
        if (error) return callback(error);

        const cmd = `docker run --restart=always -d --name="postgresql" \
                    --hostname postgresql \
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

        shell.exec('startPostgresql', cmd, function (error) {
            if (error) return callback(error);

            waitForService('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error) {
                if (error) return callback(error);
                if (!upgrading) return callback(null);

                importDatabase('postgresql', callback);
            });
        });
    });
}

function setupPostgreSql(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up postgresql');

    const { database, username } = postgreSqlNames(app.id);

    appdb.getAddonConfigByName(app.id, 'postgresql', '%POSTGRESQL_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        const data = {
            database: database,
            username: username,
            password: error ? hat(4 * 128) : existingPassword
        };

        getServiceDetails('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error, result) {
            if (error) return callback(error);

            request.post(`https://${result.ip}:3000/databases?access_token=${result.token}`, { rejectUnauthorized: false, json: data }, function (error, response) {
                if (error) return callback(new Error('Error setting up postgresql: ' + error));
                if (response.statusCode !== 201) return callback(new Error(`Error setting up postgresql. Status code: ${response.statusCode} message: ${response.body.message}`));

                const envPrefix = app.manifest.manifestVersion <= 1 ? '' : 'CLOUDRON_';

                var env = [
                    { name: `${envPrefix}POSTGRESQL_URL`, value: `postgres://${data.username}:${data.password}@postgresql/${data.database}` },
                    { name: `${envPrefix}POSTGRESQL_USERNAME`, value: data.username },
                    { name: `${envPrefix}POSTGRESQL_PASSWORD`, value: data.password },
                    { name: `${envPrefix}POSTGRESQL_HOST`, value: 'postgresql' },
                    { name: `${envPrefix}POSTGRESQL_PORT`, value: '5432' },
                    { name: `${envPrefix}POSTGRESQL_DATABASE`, value: data.database }
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

    getServiceDetails('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error, result) {
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

    getServiceDetails('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error, result) {
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

    getServiceDetails('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error, result) {
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

    getServiceDetails('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error, result) {
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

function startMongodb(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    const tag = infra.images.mongodb.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;
    const rootPassword = hat(8 * 128);
    const cloudronToken = hat(8 * 128);
    const memoryLimit = 4 * 256;

    const upgrading = existingInfra.version !== 'none' && requiresUpgrade(existingInfra.images.mongodb.tag, tag);

    if (upgrading) debug('startMongodb: mongodb will be upgraded');
    const upgradeFunc = upgrading ? shell.sudo.bind(null, 'startMongodb', [ RMADDONDIR_CMD, 'mongodb' ], {}) : (next) => next();

    upgradeFunc(function (error) {
        if (error) return callback(error);

        const cmd = `docker run --restart=always -d --name="mongodb" \
                    --hostname mongodb \
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

        shell.exec('startMongodb', cmd, function (error) {
            if (error) return callback(error);

            waitForService('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error) {
                if (error) return callback(error);
                if (!upgrading) return callback(null);

                importDatabase('mongodb', callback);
            });
        });
    });
}

function setupMongoDb(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Setting up mongodb');

    appdb.getAddonConfigByName(app.id, 'mongodb', '%MONGODB_PASSWORD', function (error, existingPassword) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(error);

        const data = {
            database: app.id,
            username: app.id,
            password: error ? hat(4 * 128) : existingPassword,
            oplog: !!options.oplog
        };

        getServiceDetails('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error, result) {
            if (error) return callback(error);

            request.post(`https://${result.ip}:3000/databases?access_token=${result.token}`, { rejectUnauthorized: false, json: data }, function (error, response) {
                if (error) return callback(new Error('Error setting up mongodb: ' + error));
                if (response.statusCode !== 201) return callback(new Error(`Error setting up mongodb. Status code: ${response.statusCode}`));

                const envPrefix = app.manifest.manifestVersion <= 1 ? '' : 'CLOUDRON_';

                var env = [
                    { name: `${envPrefix}MONGODB_URL`, value : `mongodb://${data.username}:${data.password}@mongodb:27017/${data.database}` },
                    { name: `${envPrefix}MONGODB_USERNAME`, value : data.username },
                    { name: `${envPrefix}MONGODB_PASSWORD`, value: data.password },
                    { name: `${envPrefix}MONGODB_HOST`, value : 'mongodb' },
                    { name: `${envPrefix}MONGODB_PORT`, value : '27017' },
                    { name: `${envPrefix}MONGODB_DATABASE`, value : data.database }
                ];

                if (options.oplog) {
                    env.push({ name: `${envPrefix}MONGODB_OPLOG_URL`, value : `mongodb://${data.username}:${data.password}@mongodb:27017/local?authSource=${data.database}` });
                }

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

    getServiceDetails('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error, result) {
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

    getServiceDetails('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error, result) {
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

    getServiceDetails('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error, result) {
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

    getServiceDetails('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error, result) {
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

    appdb.getAddonConfigByName(app.id, 'redis', '%REDIS_PASSWORD', function (error, existingPassword) {
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
                    --hostname ${redisName} \
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

        const envPrefix = app.manifest.manifestVersion <= 1 ? '' : 'CLOUDRON_';

        var env = [
            { name: `${envPrefix}REDIS_URL`, value: 'redis://redisuser:' + redisPassword + '@redis-' + app.id },
            { name: `${envPrefix}REDIS_PASSWORD`, value: redisPassword },
            { name: `${envPrefix}REDIS_HOST`, value: redisName },
            { name: `${envPrefix}REDIS_PORT`, value: '6379' }
        ];

        async.series([
            (next) => {
                docker.inspect(redisName, function (inspectError, result) {
                    if (!inspectError) {
                        debug(`Re-using existing redis container with state: ${JSON.stringify(result.State)}`);
                        return next();
                    }
                    shell.exec('startRedis', cmd, next);
                });
            },
            appdb.setAddonConfig.bind(null, app.id, 'redis', env),
            waitForService.bind(null, 'redis-' + app.id, 'CLOUDRON_REDIS_TOKEN')
        ], function (error) {
            if (error) debug('Error setting up redis: ', error);
            callback(error);
        });
    });
}

function clearRedis(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'Clearing redis');

    getServiceDetails('redis-' + app.id, 'CLOUDRON_REDIS_TOKEN', function (error, result) {
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

        shell.sudo('removeVolume', [ RMADDONDIR_CMD, 'redis', app.id ], {}, function (error) {
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

    getServiceDetails('redis-' + app.id, 'CLOUDRON_REDIS_TOKEN', function (error, result) {
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

    getServiceDetails('redis-' + app.id, 'CLOUDRON_REDIS_TOKEN', function (error, result) {
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
        callback(null, { status: error ? exports.SERVICE_STATUS_STOPPED: exports.SERVICE_STATUS_ACTIVE });
    });
}

function restartDocker(callback) {
    assert.strictEqual(typeof callback, 'function');

    shell.sudo('restartdocker', [ path.join(__dirname, 'scripts/restartdocker.sh') ], {}, NOOP_CALLBACK);

    callback(null);
}

function statusUnbound(callback) {
    assert.strictEqual(typeof callback, 'function');

    shell.exec('statusUnbound', 'systemctl is-active unbound', function (error) {
        callback(null, { status: error ? exports.SERVICE_STATUS_STOPPED : exports.SERVICE_STATUS_ACTIVE });
    });
}

function restartUnbound(callback) {
    assert.strictEqual(typeof callback, 'function');

    shell.sudo('restartunbound', [ path.join(__dirname, 'scripts/restartunbound.sh') ], {}, NOOP_CALLBACK);

    callback(null);
}

function statusNginx(callback) {
    assert.strictEqual(typeof callback, 'function');

    shell.exec('statusNginx', 'systemctl is-active nginx', function (error) {
        callback(null, { status: error ? exports.SERVICE_STATUS_STOPPED : exports.SERVICE_STATUS_ACTIVE });
    });
}

function restartNginx(callback) {
    assert.strictEqual(typeof callback, 'function');

    shell.sudo('reloadnginx', [ path.join(__dirname, 'scripts/reloadnginx.sh') ], {}, NOOP_CALLBACK);

    callback(null);
}

function statusSftp(callback) {
    assert.strictEqual(typeof callback, 'function');

    docker.inspect('sftp', function (error, container) {
        if (error && error.reason === DockerError.NOT_FOUND) return callback(new AddonsError(AddonsError.NOT_ACTIVE, error));
        if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

        docker.memoryUsage('sftp', function (error, result) {
            if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

            var tmp = {
                status: container.State.Running ? exports.SERVICE_STATUS_ACTIVE : exports.SERVICE_STATUS_STOPPED,
                memoryUsed: result.memory_stats.usage,
                memoryPercent: parseInt(100 * result.memory_stats.usage / result.memory_stats.limit)
            };

            callback(null, tmp);
        });
    });
}

function statusGraphite(callback) {
    assert.strictEqual(typeof callback, 'function');

    docker.inspect('graphite', function (error, container) {
        if (error && error.reason === DockerError.NOT_FOUND) return callback(new AddonsError(AddonsError.NOT_ACTIVE, error));
        if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

        request.get('http://127.0.0.1:8417', { timeout: 3000 }, function (error, response) {
            if (error) return callback(null, { status: exports.SERVICE_STATUS_STARTING, error: `Error waiting for graphite: ${error.message}` });
            if (response.statusCode !== 200) return callback(null, { status: exports.SERVICE_STATUS_STARTING, error: `Error waiting for graphite. Status code: ${response.statusCode} message: ${response.body.message}` });

            docker.memoryUsage('graphite', function (error, result) {
                if (error) return callback(new AddonsError(AddonsError.INTERNAL_ERROR, error));

                var tmp = {
                    status: container.State.Running ? exports.SERVICE_STATUS_ACTIVE : exports.SERVICE_STATUS_STOPPED,
                    memoryUsed: result.memory_stats.usage,
                    memoryPercent: parseInt(100 * result.memory_stats.usage / result.memory_stats.limit)
                };

                callback(null, tmp);
            });
        });
    });
}
