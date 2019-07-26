'use strict';

exports = module.exports = {
    sync: sync
};

var appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    constants = require('./constants.js'),
    CronJob = require('cron').CronJob,
    debug = require('debug')('box:scheduler'),
    docker = require('./docker.js'),
    _ = require('underscore');

var NOOP_CALLBACK = function (error) { if (error) debug('Unhandled error: ', error); };

// appId -> { schedulerConfig (manifest), cronjobs }
var gState = { };

function sync(callback) {
    assert(!callback || typeof callback === 'function');

    callback = callback || NOOP_CALLBACK;

    debug('sync: synchronizing global state with installed app state');

    apps.getAll(function (error, allApps) {
        if (error) return callback(error);

        var allAppIds = allApps.map(function (app) { return app.id; });
        var removedAppIds = _.difference(Object.keys(gState), allAppIds);
        if (removedAppIds.length !== 0) debug('sync: stopping jobs of removed apps %j', removedAppIds);

        async.eachSeries(removedAppIds, function (appId, iteratorDone) {
            stopJobs(appId, gState[appId], iteratorDone);
        }, function (error) {
            if (error) debug('sync: error stopping jobs of removed apps', error);

            gState = _.omit(gState, removedAppIds);

            async.eachSeries(allApps, function (app, iteratorDone) {
                var appState = gState[app.id] || null;
                var schedulerConfig = app.manifest.addons ? app.manifest.addons.scheduler : null;

                if (!appState && !schedulerConfig) return iteratorDone(); // nothing changed

                if (appState && _.isEqual(appState.schedulerConfig, schedulerConfig) && appState.cronJobs) {
                    return iteratorDone(); // nothing changed
                }

                debug(`sync: app ${app.fqdn} changed`);

                stopJobs(app.id, appState, function (error) {
                    if (error) debug(`sync: error stopping jobs of ${app.fqdn} : ${error.message}`);

                    if (!schedulerConfig) {
                        delete gState[app.id];
                        return iteratorDone();
                    }

                    gState[app.id] = {
                        schedulerConfig: schedulerConfig,
                        cronJobs: createCronJobs(app, schedulerConfig)
                    };

                    iteratorDone();
                });
            });

            debug('sync: done');
        });
    });
}

function killContainer(containerName, callback) {
    assert.strictEqual(typeof containerName, 'string');
    assert.strictEqual(typeof callback, 'function');

    async.series([
        docker.stopContainerByName.bind(null, containerName),
        docker.deleteContainerByName.bind(null, containerName)
    ], function (error) {
        if (error) debug('Failed to kill task with name %s : %s', containerName, error.message);

        callback(error);
    });
}

function stopJobs(appId, appState, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof appState, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug(`stopJobs: stopping jobs of ${appId}`);

    if (!appState) return callback();

    async.eachSeries(Object.keys(appState.schedulerConfig), function (taskName, iteratorDone) {
        if (appState.cronJobs && appState.cronJobs[taskName]) {  // could be null across restarts
            appState.cronJobs[taskName].stop();
        }

        killContainer(`${appId}-${taskName}`, iteratorDone);
    }, callback);
}

function createCronJobs(app, schedulerConfig) {
    assert.strictEqual(typeof app, 'object');
    assert(schedulerConfig && typeof schedulerConfig === 'object');

    debug(`createCronJobs: creating cron jobs for app ${app.fqdn}`);

    var jobs = { };

    Object.keys(schedulerConfig).forEach(function (taskName) {
        var task = schedulerConfig[taskName];

        const randomSecond = Math.floor(60*Math.random()); // don't start all crons to decrease memory pressure

        var cronTime = (constants.TEST ? '*/5 ' : `${randomSecond} `) + task.schedule; // time ticks faster in tests

        debug(`createCronJobs: ${app.fqdn} task ${taskName} scheduled at ${cronTime} with cmd ${task.command}`);

        var cronJob = new CronJob({
            cronTime: cronTime, // at this point, the pattern has been validated
            onTick: runTask.bind(null, app.id, taskName), //  put the app id in closure, so we don't use the outdated app object by mistake
            start: true
        });

        jobs[taskName] = cronJob;
    });

    return jobs;
}

function runTask(appId, taskName, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof taskName, 'string');
    assert(!callback || typeof callback === 'function');

    const JOB_MAX_TIME = 30 * 60 * 1000; // 30 minutes

    callback = callback || NOOP_CALLBACK;

    debug(`runTask: running task ${taskName} of ${appId}`);

    apps.get(appId, function (error, app) {
        if (error) return callback(error);

        if (app.installationState !== appdb.ISTATE_INSTALLED || app.runState !== appdb.RSTATE_RUNNING || app.health !== appdb.HEALTH_HEALTHY) {
            debug(`runTask: skipped task ${taskName} because app ${app.fqdn} has run state ${app.installationState}`);
            return callback();
        }

        const containerName = `${app.id}-${taskName}`;

        docker.inspectByName(containerName, function (err, data) {
            if (!err && data && data.State.Running === true) {
                const jobStartTime = new Date(data.State.StartedAt); // iso 8601
                if (new Date() - jobStartTime < JOB_MAX_TIME) {
                    debug(`runTask: skipped task ${taskName} of app ${app.fqdn} since it was started at ${jobStartTime}`);
                    return callback();
                }
            }

            debug(`runTask: removing any old task ${taskName} of app ${app.fqdn}`);

            killContainer(containerName, function (error) {
                if (error) return callback(error);
                const cmd = gState[appId].schedulerConfig[taskName].command;

                debug(`runTask: starting task ${taskName} of app ${app.fqdn} with cmd ${cmd}`);

                // NOTE: if you change container name here, fix addons.js to return correct container names
                docker.createSubcontainer(app, containerName, [ '/bin/sh', '-c', cmd ], { } /* options */, function (error, container) {
                    if (error) return callback(error);

                    docker.startContainer(container.id, callback);
                });
            });
        });
    });
}
