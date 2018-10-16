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
    graphs = require('./graphs.js'),
    infra = require('./infra_version.js'),
    locker = require('./locker.js'),
    mail = require('./mail.js'),
    paths = require('./paths.js'),
    reverseProxy = require('./reverseproxy.js'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    taskmanager = require('./taskmanager.js'),
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

        emitPlatformReady();

        return callback();
    }

    debug('Updating infrastructure from %s to %s', existingInfra.version, infra.version);

    var error = locker.lock(locker.OP_PLATFORM_START);
    if (error) return callback(error);

    async.series([
        stopContainers.bind(null, existingInfra),
        graphs.startGraphite.bind(null, existingInfra),
        addons.startAddons.bind(null, existingInfra),
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
