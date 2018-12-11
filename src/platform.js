'use strict';

exports = module.exports = {
    start: start,
    stop: stop,

    handleCertChanged: handleCertChanged,

    // exported for testing
    _isReady: false
};

var addons = require('./addons.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
    debug = require('debug')('box:platform'),
    fs = require('fs'),
    graphs = require('./graphs.js'),
    infra = require('./infra_version.js'),
    locker = require('./locker.js'),
    mail = require('./mail.js'),
    paths = require('./paths.js'),
    reverseProxy = require('./reverseproxy.js'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    shell = require('./shell.js'),
    taskmanager = require('./taskmanager.js'),
    _ = require('underscore');

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

        onPlatformReady();

        return callback();
    }

    debug('Updating infrastructure from %s to %s', existingInfra.version, infra.version);

    var error = locker.lock(locker.OP_PLATFORM_START);
    if (error) return callback(error);

    async.series([
        stopContainers.bind(null, existingInfra),
        // mark app state before we start addons. this gives the db import logic a chance to mark an app as errored
        startApps.bind(null, existingInfra),
        graphs.startGraphite.bind(null, existingInfra),
        addons.startServices.bind(null, existingInfra),
        fs.writeFile.bind(fs, paths.INFRA_VERSION_FILE, JSON.stringify(infra, null, 4))
    ], function (error) {
        if (error) return callback(error);

        locker.unlock(locker.OP_PLATFORM_START);

        onPlatformReady();

        callback();
    });
}

function stop(callback) {
    taskmanager.pauseTasks(callback);
}

function onPlatformReady() {
    debug('onPlatformReady: platform is ready');
    exports._isReady = true;
    taskmanager.resumeTasks();

    applyPlatformConfig(NOOP_CALLBACK);
    pruneInfraImages(NOOP_CALLBACK);
}

function applyPlatformConfig(callback) {
    // scale back db containers, if possible. this is retried because updating memory constraints can fail
    // with failed to write to memory.memsw.limit_in_bytes: write /sys/fs/cgroup/memory/docker/xx/memory.memsw.limit_in_bytes: device or resource busy

    async.retry({ times: 10, interval: 5 * 60 * 1000 }, function (retryCallback) {
        settings.getPlatformConfig(function (error, platformConfig) {
            if (error) return retryCallback(error);

            addons.updateServiceConfig(platformConfig, function (error) {
                if (error) debug('Error updating services. Will rety in 5 minutes', platformConfig, error);

                retryCallback(error);
            });
        });
    }, callback);
}

function pruneInfraImages(callback) {
    debug('pruneInfraImages: checking existing images');

    // cannot blindly remove all unused images since redis image may not be used
    const images = infra.baseImages.concat(Object.keys(infra.images).map(function (addon) { return infra.images[addon]; }));

    async.eachSeries(images, function (image, iteratorCallback) {
        let output = safe.child_process.execSync(`docker images --digests ${image.repo} --format "{{.ID}} {{.Repository}}:{{.Tag}}@{{.Digest}}"`, { encoding: 'utf8' });
        if (output === null) return iteratorCallback(safe.error);

        let lines = output.trim().split('\n');
        for (let line of lines) {
            if (!line) continue;
            let parts = line.split(' '); // [ ID, Repo:Tag@Digest ]
            if (image.tag === parts[1]) continue; // keep
            debug(`pruneInfraImages: removing unused image of ${image.repo}: ${line}`);

            shell.exec('pruneInfraImages', `docker rmi ${parts[0]}`, iteratorCallback);
        }
    }, callback);
}

function stopContainers(existingInfra, callback) {
    // always stop addons to restart them on any infra change, regardless of minor or major update
    if (existingInfra.version !== infra.version) {
        // TODO: only nuke containers with isCloudronManaged=true
        debug('stopping all containers for infra upgrade');
        async.series([
            shell.exec.bind(null, 'stopContainers', 'docker ps -qa | xargs --no-run-if-empty docker stop'),
            shell.exec.bind(null, 'stopContainers', 'docker ps -qa | xargs --no-run-if-empty docker rm -f')
        ], callback);
    } else {
        assert(typeof infra.images, 'object');
        var changedAddons = [ ];
        for (var imageName in infra.images) {
            if (infra.images[imageName].tag !== existingInfra.images[imageName].tag) changedAddons.push(imageName);
        }

        debug('stopContainer: stopping addons for incremental infra update: %j', changedAddons);
        let filterArg = changedAddons.map(function (c) { return `--filter 'name=${c}'`; }).join(' '); // name=c matches *c*. required for redis-{appid}
        // ignore error if container not found (and fail later) so that this code works across restarts
        async.series([
            shell.exec.bind(null, 'stopContainers', `docker ps -qa ${filterArg} | xargs --no-run-if-empty docker stop || true`),
            shell.exec.bind(null, 'stopContainers', `docker ps -qa ${filterArg} | xargs --no-run-if-empty docker rm -f || true`)
        ], callback);
    }
}

function startApps(existingInfra, callback) {
    if (existingInfra.version === 'none') { // cloudron is being restored from backup
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

function handleCertChanged(cn, callback) {
    assert.strictEqual(typeof cn, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('handleCertChanged', cn);

    if (cn === '*.' + config.adminDomain() || cn === config.adminFqdn()) return mail.startMail(callback);

    callback();
}
