'use strict';

exports = module.exports = {
    start: start,
    stop: stop,

    handleCertChanged: handleCertChanged
};

var addons = require('./addons.js'),
    apps = require('./apps.js'),
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
    path = require('path'),
    paths = require('./paths.js'),
    reverseProxy = require('./reverseproxy.js'),
    safe = require('safetydance'),
    semver = require('semver'),
    settings = require('./settings.js'),
    shell = require('./shell.js'),
    taskmanager = require('./taskmanager.js'),
    _ = require('underscore');

var gPlatformReadyTimer = null;

const RMADDON_CMD = path.join(__dirname, 'scripts/rmaddon.sh');

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

    settings.events.on(settings.PLATFORM_CONFIG_KEY, updateAddons);

    // short-circuit for the restart case
    if (_.isEqual(infra, existingInfra)) {
        debug('platform is uptodate at version %s', infra.version);

        emitPlatformReady();

        return callback();
    }

    debug('Updating infrastructure from %s to %s', existingInfra.version, infra.version);

    var error = locker.lock(locker.OP_PLATFORM_START);
    if (error) return callback(error);

    async.series([
        stopContainers.bind(null, existingInfra),
        startAddons.bind(null, existingInfra),
        removeOldImages,
        startApps.bind(null, existingInfra),
        fs.writeFile.bind(fs, paths.INFRA_VERSION_FILE, JSON.stringify(infra, null, 4))
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

function updateAddons(platformConfig, callback) {
    callback = callback || NOOP_CALLBACK;

    // TODO: this should possibly also rollback memory to default
    async.eachSeries([ 'mysql', 'postgresql', 'mail', 'mongodb' ], function iterator(containerName, iteratorCallback) {
        const containerConfig = platformConfig[containerName];
        if (!containerConfig) return iteratorCallback();

        if (!containerConfig.memory || !containerConfig.memorySwap) return iteratorCallback();

        const args = `update --memory ${containerConfig.memory} --memory-swap ${containerConfig.memorySwap} ${containerName}`.split(' ');
        shell.exec(`update${containerName}`, '/usr/bin/docker', args, { }, iteratorCallback);
    }, callback);
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
        const image = infra.images[imageName];
        const tag = image.tag.replace(/:.*@/, '@'); // this remove the semver tag
        debug('cleaning up images of %j', image);
        // older docker images did not have sha256 and thus have it as <none>
        const cmd = `docker images --digests "${image.repo}" | tail -n +2 | awk '{ print $1 ($3=="<none>" ? (":" $2) : ("@" $3)) }' | grep -v "${tag}" | xargs --no-run-if-empty docker rmi`;
        shell.execSync('removeOldImagesSync', cmd);
    }

    callback();
}

function stopContainers(existingInfra, callback) {
    // always stop addons to restart them on any infra change, regardless of minor or major update
    if (existingInfra.version !== infra.version) {
        debug('stopping all containers for infra upgrade');
        shell.execSync('stopContainers', 'docker ps -qa | xargs --no-run-if-empty docker stop');
        shell.execSync('stopContainers', 'docker ps -qa | xargs --no-run-if-empty docker rm -f');
    } else {
        assert(typeof infra.images, 'object');
        var changedAddons = [ ];
        for (var imageName in infra.images) {
            if (imageName === 'redis') continue; // see #223
            if (infra.images[imageName].tag !== existingInfra.images[imageName].tag) changedAddons.push(imageName);
        }

        debug('stopContainer: stopping addons for incremental infra update: %j', changedAddons);
        let filterArg = changedAddons.map(function (c) { return `--filter 'name=${c}`; }).join(' '); // name=c matches *c*. required for redis-{appid}
        // ignore error if container not found (and fail later) so that this code works across restarts
        shell.execSync('stopContainers', `docker ps -qa ${filterArg} | xargs --no-run-if-empty docker stop || true`);
        shell.execSync('stopContainers', `docker ps -qa ${filterArg} | xargs --no-run-if-empty docker rm -f || true`);
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
                -v "${dataDir}/graphite:/var/lib/graphite" \
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startGraphite', cmd);

    callback();
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

function startMysql(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    const tag = infra.images.mysql.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;
    const rootPassword = hat(8 * 128);
    const cloudronToken = hat(8 * 128);
    const memoryLimit = (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 256;

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
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startMysql', cmd);

    addons.waitForAddon('mysql', 'CLOUDRON_MYSQL_TOKEN', function (error) {
        if (error) return callback(error);
        if (!upgrading) return callback(null);

        addons.importDatabase('mysql', callback);
    });
}

function startPostgresql(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    const tag = infra.images.postgresql.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;
    const rootPassword = hat(8 * 128);
    const cloudronToken = hat(8 * 128);
    const memoryLimit = (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 256;

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
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startPostgresql', cmd);

    addons.waitForAddon('postgresql', 'CLOUDRON_POSTGRESQL_TOKEN', function (error) {
        if (error) return callback(error);
        if (!upgrading) return callback(null);

        addons.importDatabase('postgresql', callback);
    });
}

function startMongodb(existingInfra, callback) {
    assert.strictEqual(typeof existingInfra, 'object');
    assert.strictEqual(typeof callback, 'function');

    const tag = infra.images.mongodb.tag;
    const dataDir = paths.PLATFORM_DATA_DIR;
    const rootPassword = hat(8 * 128);
    const cloudronToken = hat(8 * 128);
    const memoryLimit = (1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 200;


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
                --read-only -v /tmp -v /run "${tag}"`;

    shell.execSync('startMongodb', cmd);

    addons.waitForAddon('mongodb', 'CLOUDRON_MONGODB_TOKEN', function (error) {
        if (error) return callback(error);
        if (!upgrading) return callback(null);

        addons.importDatabase('mongodb', callback);
    });
}

function startAddons(existingInfra, callback) {
    var startFuncs = [ ];

    // always start addons on any infra change, regardless of minor or major update
    if (existingInfra.version !== infra.version) {
        debug('startAddons: no existing infra or infra upgrade. starting all addons');
        startFuncs.push(
            startGraphite,
            startMysql.bind(null, existingInfra),
            startPostgresql.bind(null, existingInfra),
            startMongodb.bind(null, existingInfra),
            mail.startMail);
    } else {
        assert.strictEqual(typeof existingInfra.images, 'object');

        if (infra.images.graphite.tag !== existingInfra.images.graphite.tag) startFuncs.push(startGraphite);
        if (infra.images.mysql.tag !== existingInfra.images.mysql.tag) startFuncs.push(startMysql.bind(null, existingInfra));
        if (infra.images.postgresql.tag !== existingInfra.images.postgresql.tag) startFuncs.push(startPostgresql.bind(null, existingInfra));
        if (infra.images.mongodb.tag !== existingInfra.images.mongodb.tag) startFuncs.push(startMongodb.bind(null, existingInfra));
        if (infra.images.mail.tag !== existingInfra.images.mail.tag) startFuncs.push(mail.startMail);

        debug('startAddons: existing infra. incremental addon create %j', startFuncs.map(function (f) { return f.name; }));
    }

    async.series(startFuncs, function (error) {
        if (error) return callback(error);

        settings.getPlatformConfig(function (error, platformConfig) {
            if (error) return callback(error);

            updateAddons(platformConfig, callback);
        });
    });
}

function startApps(existingInfra, callback) {
    if (existingInfra.version === 'none') {
        debug('startApps: restoring installed apps');
        apps.restoreInstalledApps(callback);
    } else if (existingInfra.version !== infra.version) {
        debug('startApps: reconfiguring installed apps');
        reverseProxy.removeAppConfigs(); // should we change the cert location, nginx will not start
        apps.configureInstalledApps(callback);
    } else {
        debug('startApps: apps are already uptodate');
        callback();
    }
}

function handleCertChanged(cn) {
    assert.strictEqual(typeof cn, 'string');

    if (cn === '*.' + config.adminDomain() || cn === config.adminFqdn()) {
        mail.startMail(NOOP_CALLBACK);
    }
}
