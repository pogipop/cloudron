'use strict';

exports = module.exports = {
    sync: sync
};

var appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
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

    debug('Syncing');

    apps.getAll(function (error, allApps) {
        if (error) return callback(error);

        var allAppIds = allApps.map(function (app) { return app.id; });
        var removedAppIds = _.difference(Object.keys(gState), allAppIds);
        if (removedAppIds.length !== 0) debug('sync: stopping jobs of removed apps %j', removedAppIds);

        async.eachSeries(removedAppIds, function (appId, iteratorDone) {
            stopJobs(appId, gState[appId], iteratorDone);
        }, function (error) {
            if (error) debug('Error stopping jobs of removed apps', error);

            gState = _.omit(gState, removedAppIds);

            debug('sync: checking apps %j', allAppIds);
            async.eachSeries(allApps, function (app, iteratorDone) {
                var appState = gState[app.id] || null;
                var schedulerConfig = app.manifest.addons ? app.manifest.addons.scheduler : null;

                if (!appState && !schedulerConfig) return iteratorDone(); // nothing changed

                if (appState && _.isEqual(appState.schedulerConfig, schedulerConfig) && appState.cronJobs) {
                    return iteratorDone(); // nothing changed
                }

                debug('sync: app %s changed', app.id);
                stopJobs(app.id, appState, function (error) {
                    if (error) debug('Error stopping jobs for %s : %s', app.id, error.message);

                    if (!schedulerConfig) {
                        delete gState[app.id];
                        return iteratorDone();
                    }

                    gState[app.id] = {
                        schedulerConfig: schedulerConfig,
                        cronJobs: createCronJobs(app.id, schedulerConfig)
                    };

                    iteratorDone();
                });
            });

            debug('Done syncing');
        });
    });
}

function killContainer(containerName, callback) {
    if (!containerName) return callback();

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

    debug('stopJobs for %s', appId);

    if (!appState) return callback();

    async.eachSeries(Object.keys(appState.schedulerConfig), function (taskName, iteratorDone) {
        if (appState.cronJobs && appState.cronJobs[taskName]) {  // could be null across restarts
            appState.cronJobs[taskName].stop();
        }

        var containerName = appId + '-' + taskName;
        killContainer(containerName, iteratorDone);
    }, callback);
}

function createCronJobs(appId, schedulerConfig) {
    assert.strictEqual(typeof appId, 'string');
    assert(schedulerConfig && typeof schedulerConfig === 'object');

    debug('creating cron jobs for app %s', appId);

    var jobs = { };

    Object.keys(schedulerConfig).forEach(function (taskName) {
        var task = schedulerConfig[taskName];

        var cronTime = (config.TEST ? '*/5 ' : '00 ') + task.schedule; // time ticks faster in tests

        debug('scheduling task for %s/%s @ %s : %s', appId, taskName, cronTime, task.command);

        var cronJob = new CronJob({
            cronTime: cronTime, // at this point, the pattern has been validated
            onTick: doTask.bind(null, appId, taskName),
            start: true
        });

        jobs[taskName] = cronJob;
    });

    return jobs;
}

function doTask(appId, taskName, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof taskName, 'string');
    assert(!callback || typeof callback === 'function');

    callback = callback || NOOP_CALLBACK;

    debug('Executing task %s/%s', appId, taskName);

    apps.get(appId, function (error, app) {
        if (error) return callback(error);

        if (app.installationState !== appdb.ISTATE_INSTALLED || app.runState !== appdb.RSTATE_RUNNING || app.health !== appdb.HEALTH_HEALTHY) {
            debug('task %s skipped. app %s is not installed/running/healthy', taskName, app.id);
            return callback();
        }

        var containerName = app.id + '-' + taskName;

        killContainer(containerName, function (error) {
            if (error) return callback(error);

            debug('Creating subcontainer for %s/%s : %s', app.id, taskName, gState[appId].schedulerConfig[taskName].command);

            // NOTE: if you change container name here, fix addons.js to return correct container names
            docker.createSubcontainer(app, containerName, [ '/bin/sh', '-c', gState[appId].schedulerConfig[taskName].command ], { } /* options */, function (error, container) {
                if (error) return callback(error);

                docker.startContainer(container.id, callback);
            });
        });
    });
}
