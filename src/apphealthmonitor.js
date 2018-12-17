'use strict';

var appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:apphealthmonitor'),
    docker = require('./docker.js').connection,
    mailer = require('./mailer.js'),
    superagent = require('superagent'),
    util = require('util');

exports = module.exports = {
    run: run
};

const HEALTHCHECK_INTERVAL = 10 * 1000; // every 10 seconds. this needs to be small since the UI makes only healthy apps clickable
const UNHEALTHY_THRESHOLD = 10 * 60 * 1000; // 10 minutes
let gHealthInfo = { }; // { time, emailSent }

const OOM_MAIL_LIMIT = 60 * 60 * 1000; // 60 minutes
let gLastOomMailTime = Date.now() - (5 * 60 * 1000); // pretend we sent email 5 minutes ago

function debugApp(app) {
    assert(typeof app === 'object');

    debug(app.fqdn + ' ' + app.manifest.id + ' ' + util.format.apply(util, Array.prototype.slice.call(arguments, 1)) + ' - ' + app.id);
}

function setHealth(app, health, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof health, 'string');
    assert.strictEqual(typeof callback, 'function');

    var now = new Date();

    if (!(app.id in gHealthInfo)) { // add new apps to list
        gHealthInfo[app.id] = { time: now, emailSent: false };
    }

    if (health === appdb.HEALTH_HEALTHY) {
        gHealthInfo[app.id].time = now;
    } else if (Math.abs(now - gHealthInfo[app.id].time) > UNHEALTHY_THRESHOLD) {
        if (gHealthInfo[app.id].emailSent) return callback(null);

        debugApp(app, 'marking as unhealthy since not seen for more than %s minutes', UNHEALTHY_THRESHOLD/(60 * 1000));

        if (!app.debugMode) mailer.appDied(app); // do not send mails for dev apps
        gHealthInfo[app.id].emailSent = true;
    } else {
        debugApp(app, 'waiting for sometime to update the app health');
        return callback(null);
    }

    appdb.setHealth(app.id, health, function (error) {
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

    var container = docker.getContainer(app.containerId),
        manifest = app.manifest;

    container.inspect(function (err, data) {
        if (err || !data || !data.State) {
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
            .set('User-Agent', 'Mozilla') // required for some apps (e.g. minio)
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
            var ev = JSON.parse(data);
            appdb.getByContainerId(ev.id, function (error, app) { // this can error for addons
                var program = error || !app.appStoreId ? ev.id : app.appStoreId;
                var context = JSON.stringify(ev);
                var now = Date.now();
                if (app) context = context + '\n\n' + JSON.stringify(app, null, 4) + '\n';

                const notifyUser = (!app || !app.debugMode) && (now - gLastOomMailTime > OOM_MAIL_LIMIT);

                debug('OOM Context: %s. notifyUser: %s. lastOomTime: %s (now: %s)', context, notifyUser, gLastOomMailTime, now);

                // do not send mails for dev apps
                if (notifyUser) {
                    mailer.oomEvent(program, context); // app can be null if it's an addon crash
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
