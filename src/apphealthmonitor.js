'use strict';

var appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    auditSource = require('./auditsource.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:apphealthmonitor'),
    docker = require('./docker.js'),
    eventlog = require('./eventlog.js'),
    safe = require('safetydance'),
    superagent = require('superagent'),
    util = require('util');

exports = module.exports = {
    run: run
};

const HEALTHCHECK_INTERVAL = 10 * 1000; // every 10 seconds. this needs to be small since the UI makes only healthy apps clickable
const UNHEALTHY_THRESHOLD = 10 * 60 * 1000; // 10 minutes

const OOM_EVENT_LIMIT = 60 * 60 * 1000; // 60 minutes
let gLastOomMailTime = Date.now() - (5 * 60 * 1000); // pretend we sent email 5 minutes ago

function debugApp(app) {
    assert(typeof app === 'object');

    debug(app.fqdn + ' ' + app.manifest.id + ' ' + util.format.apply(util, Array.prototype.slice.call(arguments, 1)) + ' - ' + app.id);
}

function setHealth(app, health, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof health, 'string');
    assert.strictEqual(typeof callback, 'function');

    let now = new Date(), healthTime = app.healthTime, curHealth = app.health;

    if (health === appdb.HEALTH_HEALTHY) {
        healthTime = now;
        if (curHealth && curHealth !== appdb.HEALTH_HEALTHY) { // app starts out with null health
            debugApp(app, 'app switched from %s to healthy', curHealth);

            // do not send mails for dev apps
            if (!app.debugMode) eventlog.add(eventlog.ACTION_APP_UP, auditSource.HEALTH_MONITOR, { app: app });
        }
    } else if (Math.abs(now - healthTime) > UNHEALTHY_THRESHOLD) {
        if (curHealth === appdb.HEALTH_HEALTHY) {
            debugApp(app, 'marking as unhealthy since not seen for more than %s minutes', UNHEALTHY_THRESHOLD/(60 * 1000));

            // do not send mails for dev apps
            if (!app.debugMode) eventlog.add(eventlog.ACTION_APP_DOWN, auditSource.HEALTH_MONITOR, { app: app });
        }
    } else {
        debugApp(app, 'waiting for %s seconds to update the app health', (UNHEALTHY_THRESHOLD - Math.abs(now - healthTime))/1000);
        return callback(null);
    }

    appdb.setHealth(app.id, health, healthTime, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null); // app uninstalled?
        if (error) return callback(error);

        app.health = health;

        callback(null);
    });
}


// callback is called with error for fatal errors and not if health check failed
function checkAppHealth(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (app.installationState !== appdb.ISTATE_INSTALLED || app.runState !== appdb.RSTATE_RUNNING) {
        debugApp(app, 'skipped. istate:%s rstate:%s', app.installationState, app.runState);
        return callback(null);
    }

    const manifest = app.manifest;

    docker.inspect(app.containerId, function (error, data) {
        if (error || !data || !data.State) {
            debugApp(app, 'Error inspecting container');
            return setHealth(app, appdb.HEALTH_ERROR, callback);
        }

        if (data.State.Running !== true) {
            debugApp(app, 'exited');
            return setHealth(app, appdb.HEALTH_DEAD, callback);
        }

        // non-appstore apps may not have healthCheckPath
        if (!manifest.healthCheckPath) return setHealth(app, appdb.HEALTH_HEALTHY, callback);

        // poll through docker network instead of nginx to bypass any potential oauth proxy
        var healthCheckUrl = 'http://127.0.0.1:' + app.httpPort + manifest.healthCheckPath;
        superagent
            .get(healthCheckUrl)
            .set('Host', app.fqdn) // required for some apache configs with rewrite rules
            .set('User-Agent', 'Mozilla (Cloudron)') // required for some apps (e.g. minio)
            .redirects(0)
            .timeout(HEALTHCHECK_INTERVAL)
            .end(function (error, res) {
                if (error && !error.response) {
                    debugApp(app, 'not alive (network error): %s', error.message);
                    setHealth(app, appdb.HEALTH_UNHEALTHY, callback);
                } else if (res.statusCode >= 400) { // 2xx and 3xx are ok
                    debugApp(app, 'not alive : %s', error || res.status);
                    setHealth(app, appdb.HEALTH_UNHEALTHY, callback);
                } else {
                    setHealth(app, appdb.HEALTH_HEALTHY, callback);
                }
            });
    });
}

function getContainerInfo(containerId, callback) {
    docker.inspect(containerId, function (error, result) {
        if (error) return callback(error);

        const appId = safe.query(result, 'Config.Labels.appId', null);

        if (!appId) return callback(null, null /* app */, { name: result.Name }); // addon

        apps.get(appId, callback); // don't get by container id as this can be an exec container
    });
}

/*
    OOM can be tested using stress tool like so:
        docker run -ti -m 100M cloudron/base:0.10.0 /bin/bash
        apt-get update && apt-get install stress
        stress --vm 1 --vm-bytes 200M --vm-hang 0
*/
function processDockerEvents(intervalSecs, callback) {
    assert.strictEqual(typeof intervalSecs, 'number');
    assert.strictEqual(typeof callback, 'function');

    const since = ((new Date().getTime() / 1000) - intervalSecs).toFixed(0);
    const until = ((new Date().getTime() / 1000) - 1).toFixed(0);

    docker.getEvents({ since: since, until: until, filters: JSON.stringify({ event: [ 'oom' ] }) }, function (error, stream) {
        if (error) return callback(error);

        stream.setEncoding('utf8');
        stream.on('data', function (data) {
            const event = JSON.parse(data);
            const containerId = String(event.id);

            getContainerInfo(containerId, function (error, app, addon) {
                const program = error ? containerId : (app ? app.fqdn : addon.name);
                const now = Date.now();
                const notifyUser = !(app && app.debugMode) && ((now - gLastOomMailTime) > OOM_EVENT_LIMIT);

                debug('OOM %s notifyUser: %s. lastOomTime: %s (now: %s)', program, notifyUser, gLastOomMailTime, now);

                // do not send mails for dev apps
                if (notifyUser) {
                    // app can be null for addon containers
                    eventlog.add(eventlog.ACTION_APP_OOM, auditSource.HEALTH_MONITOR, { event: event, containerId: containerId, addon: addon || null, app: app || null });

                    gLastOomMailTime = now;
                }
            });
        });

        stream.on('error', function (error) {
            debug('Error reading docker events', error);
            callback();
        });

        stream.on('end', callback);

        // safety hatch if 'until' doesn't work (there are cases where docker is working with a different time)
        setTimeout(stream.destroy.bind(stream), 3000); // https://github.com/apocas/dockerode/issues/179
    });
}

function processApp(callback) {
    assert.strictEqual(typeof callback, 'function');

    apps.getAll(function (error, result) {
        if (error) return callback(error);

        async.each(result, checkAppHealth, function (error) {
            if (error) console.error(error);

            var alive = result
                .filter(function (a) { return a.installationState === appdb.ISTATE_INSTALLED && a.runState === appdb.RSTATE_RUNNING && a.health === appdb.HEALTH_HEALTHY; })
                .map(function (a) { return (a.location || 'naked_domain') + '|' + a.manifest.id; }).join(', ');

            debug('apps alive: [%s]', alive);

            callback(null);
        });
    });
}

function run(intervalSecs, callback) {
    assert.strictEqual(typeof intervalSecs, 'number');
    assert.strictEqual(typeof callback, 'function');

    async.series([
        processApp, // this is first because docker.getEvents seems to get 'stuck' sometimes
        processDockerEvents.bind(null, intervalSecs)
    ], function (error) {
        if (error) debug(error);

        callback();
    });
}
