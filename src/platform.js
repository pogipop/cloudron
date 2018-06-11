'use strict';

exports = module.exports = {
    start: start,
    stop: stop,

    handleCertChanged: handleCertChanged
};

var apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
    debug = require('debug')('box:platform'),
    fs = require('fs'),
    hat = require('./hat.js'),
    infra = require('./infra_version.js'),
    locker = require('./locker.js'),
    mail = require('./mail.js'),
    os = require('os'),
    paths = require('./paths.js'),
    reverseProxy = require('./reverseproxy.js'),
    safe = require('safetydance'),
    semver = require('semver'),
    settings = require('./settings.js'),
    shell = require('./shell.js'),
    taskmanager = require('./taskmanager.js'),
    util = require('util'),
    _ = require('underscore');

var gPlatformReadyTimer = null;

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

function start(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (process.env.BOX_ENV === 'test' && !process.env.TEST_CREATE_INFRA) return callback();

    debug('initializing addon infrastructure');

    var existingInfra = { version: 'none' };
    if (fs.existsSync(paths.INFRA_VERSION_FILE)) {
        existingInfra = safe.JSON.parse(fs.readFileSync(paths.INFRA_VERSION_FILE, 'utf8'));
        if (!existingInfra) existingInfra = { version: 'corrupt' };
    }

    // short-circuit for the restart case
    if (_.isEqual(infra, existingInfra)) {
        debug('platform is uptodate at version %s', infra.version);

        updateAddons(function (error) {
            if (error) return callback(error);

            emitPlatformReady();

            callback();
        });
        return;
    }

    debug('Updating infrastructure from %s to %s', existingInfra.version, infra.version);

    var error = locker.lock(locker.OP_PLATFORM_START);
    if (error) return callback(error);

    async.series([
        stopContainers.bind(null, existingInfra),
        startAddons.bind(null, existingInfra),
        removeOldImages,
        startApps.bind(null, existingInfra),
        fs.writeFile.bind(fs, paths.INFRA_VERSION_FILE, JSON.stringify(infra, null, 4)),
        updateAddons
    ], function (error) {
        if (error) return callback(error);

        locker.unlock(locker.OP_PLATFORM_START);

        emitPlatformReady();

        callback();
    });
}

function stop(callback) {
    clearTimeout(gPlatformReadyTimer);
    gPlatformReadyTimer = null;
    exports.events = null;
    taskmanager.pauseTasks(callback);
}

function updateAddons(callback) {
    settings.getPlatformConfig(function (error, platformConfig) {
        if (error) return callback(error);

        for (var containerName of [ 'mysql', 'postgresql', 'mail', 'mongodb' ]) {
            const containerConfig = platformConfig[containerName];
            if (!containerConfig) continue;

            if (!containerConfig.memory || !containerConfig.memorySwap) continue;

            const cmd = `docker update --memory ${containerConfig.memory} --memory-swap ${containerConfig.memorySwap} ${containerName}`;
            shell.execSync(`update${containerName}`, cmd);
        }

        callback();
    });
}

function emitPlatformReady() {
    // give some time for the platform to "settle". For example, mysql might still be initing the
    // database dir and we cannot call service scripts until that's done.
    // TODO: make this smarter to not wait for 15secs for the crash-restart case
    gPlatformReadyTimer = setTimeout(function () {
        debug('emitting platform ready');
        gPlatformReadyTimer = null;
        taskmanager.resumeTasks();
    }, 15000);
}

function removeOldImages(callback) {
    debug('removing old addon images');

    for (var imageName in infra.images) {
        if (imageName === 'redis') continue; // see #223
        var image = infra.images[imageName];
        debug('cleaning up images of %j', image);
        var cmd = 'docker images "%s" | tail -n +2 | awk \'{ print $1 ":" $2 }\' | grep -v "%s" | xargs --no-run-if-empty docker rmi';
        shell.execSync('removeOldImagesSync', util.format(cmd, image.repo, image.tag));
    }

    callback();
}

function stopContainers(existingInfra, callback) {
    // TODO: be nice and stop addons cleanly (example, shutdown commands)

    // always stop addons to restart them on any infra change, regardless of minor or major update
    if (existingInfra.version !== infra.version) {
        debug('stopping all containers for infra upgrade');
        shell.execSync('stopContainers', 'docker ps -qa | xargs --no-run-if-empty docker rm -f');
    } else {
        assert(typeof infra.images, 'object');
        var changedAddons = [ ];
        for (var imageName in infra.images) {
            if (imageName === 'redis') continue; // see #223
            if (infra.images[imageName].tag !== existingInfra.images[imageName].tag) changedAddons.push(imageName);
        }

        debug('stopping addons for incremental infra update: %j', changedAddons);
        // ignore error if container not found (and fail later) so that this code works across restarts
        shell.execSync('stopContainers', 'docker rm -f ' + changedAddons.join(' ') + ' || true');
    }

    callback();
}

function startGraphite(callback) {
    const tag = infra.images.graphite.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;

    const cmd = `docker run --restart=always -d --name="graphite" \
                --net cloudron \
                --net-alias graphite \
                --log-driver syslog \
                --log-opt syslog-address=udp://127.0.0.1:2514 \
                --log-opt syslog-format=rfc5424 \
                --log-opt tag=graphite \
                -m 75m \
                --memory-swap 150m \
                --dns 172.18.0.1 \
                --dns-search=. \
                -p 127.0.0.1:2003:2003 \
                -p 127.0.0.1:2004:2004 \
                -p 127.0.0.1:8000:8000 \
                -v "${dataDir}/graphite:/app/data" \
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startGraphite', cmd);

    callback();
}

function startMysql(callback) {
    const tag = infra.images.mysql.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;
    const rootPassword = hat(8 * 128);
    const memoryLimit = (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 256;

    if (!safe.fs.writeFileSync(paths.ADDON_CONFIG_DIR + '/mysql_vars.sh',
        'MYSQL_ROOT_PASSWORD=' + rootPassword +'\nMYSQL_ROOT_HOST=172.18.0.1', 'utf8')) {
        return callback(new Error('Could not create mysql var file:' + safe.error.message));
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
                -v "${dataDir}/mysql:/var/lib/mysql" \
                -v "${dataDir}/addons/mysql_vars.sh:/etc/mysql/mysql_vars.sh:ro" \
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startMysql', cmd);

    setTimeout(callback, 5000);
}

function startPostgresql(callback) {
    const tag = infra.images.postgresql.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;
    const rootPassword = hat(8 * 128);
    const memoryLimit = (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 256;

    if (!safe.fs.writeFileSync(paths.ADDON_CONFIG_DIR + '/postgresql_vars.sh', 'POSTGRESQL_ROOT_PASSWORD=' + rootPassword, 'utf8')) {
        return callback(new Error('Could not create postgresql var file:' + safe.error.message));
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
                -v "${dataDir}/postgresql:/var/lib/postgresql" \
                -v "${dataDir}/addons/postgresql_vars.sh:/etc/postgresql/postgresql_vars.sh:ro" \
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startPostgresql', cmd);

    setTimeout(callback, 5000);
}

function startMongodb(callback) {
    const tag = infra.images.mongodb.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;
    const rootPassword = hat(8 * 128);
    const memoryLimit = (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 200;

    if (!safe.fs.writeFileSync(paths.ADDON_CONFIG_DIR + '/mongodb_vars.sh', 'MONGODB_ROOT_PASSWORD=' + rootPassword, 'utf8')) {
        return callback(new Error('Could not create mongodb var file:' + safe.error.message));
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
                -v "${dataDir}/mongodb:/var/lib/mongodb" \
                -v "${dataDir}/addons/mongodb_vars.sh:/etc/mongodb_vars.sh:ro" \
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startMongodb', cmd);

    setTimeout(callback, 5000);
}

function startAddons(existingInfra, callback) {
    var startFuncs = [ ];

    // always start addons on any infra change, regardless of minor or major update
    if (existingInfra.version !== infra.version) {
        debug('startAddons: no existing infra or infra upgrade. starting all addons');
        startFuncs.push(startGraphite, startMysql, startPostgresql, startMongodb, mail.startMail);
    } else {
        assert.strictEqual(typeof existingInfra.images, 'object');

        if (infra.images.graphite.tag !== existingInfra.images.graphite.tag) startFuncs.push(startGraphite);
        if (infra.images.mysql.tag !== existingInfra.images.mysql.tag) startFuncs.push(startMysql);
        if (infra.images.postgresql.tag !== existingInfra.images.postgresql.tag) startFuncs.push(startPostgresql);
        if (infra.images.mongodb.tag !== existingInfra.images.mongodb.tag) startFuncs.push(startMongodb);
        if (infra.images.mail.tag !== existingInfra.images.mail.tag) startFuncs.push(mail.startMail);

        debug('startAddons: existing infra. incremental addon create %j', startFuncs.map(function (f) { return f.name; }));
    }

    async.series(startFuncs, callback);
}

function startApps(existingInfra, callback) {
    // Infra version change strategy:
    // * no existing version - restore apps
    // * major versions - restore apps
    // * minor versions - reconfigure apps

    if (existingInfra.version === infra.version) {
        debug('startApp: apps are already uptodate');
        callback();
    } else if (existingInfra.version === 'none' || !semver.valid(existingInfra.version) || semver.major(existingInfra.version) !== semver.major(infra.version)) {
        debug('startApps: restoring installed apps');
        apps.restoreInstalledApps(callback);
    } else {
        debug('startApps: reconfiguring installed apps');
        reverseProxy.removeAppConfigs(); // should we change the cert location, nginx will not start
        apps.configureInstalledApps(callback);
    }
}

function handleCertChanged(cn) {
    assert.strictEqual(typeof cn, 'string');

    if (cn === '*.' + config.adminDomain() || cn === config.adminFqdn()) {
        mail.startMail(NOOP_CALLBACK);
    }
}
