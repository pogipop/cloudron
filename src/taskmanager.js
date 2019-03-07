'use strict';

exports = module.exports = {
    resumeTasks: resumeTasks,
    pauseTasks: pauseTasks,

    stopAppTask: stopAppTask,
    startAppTask: startAppTask,
    restartAppTask: restartAppTask,

    stopPendingTasks: stopPendingTasks,
    waitForPendingTasks: waitForPendingTasks
};

var appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    child_process = require('child_process'),
    debug = require('debug')('box:taskmanager'),
    fs = require('fs'),
    locker = require('./locker.js'),
    mkdirp = require('mkdirp'),
    path = require('path'),
    paths = require('./paths.js'),
    eventlog = require('./eventlog.js'),
    util = require('util'),
    _ = require('underscore');

var gActiveTasks = { };
var gPendingTasks = [ ];

var TASK_CONCURRENCY = 3;
var NOOP_CALLBACK = function (error) { if (error) debug(error); };
var gPaused = true;

const AUDIT_SOURCE = { userId: null, username: 'taskmanager' };

// resume app tasks when platform is ready or after a crash
function resumeTasks(callback) {
    callback = callback || NOOP_CALLBACK;

    debug('resuming tasks');

    locker.on('unlocked', startNextTask);

    gPaused = false;

    apps.getAll(function (error, result) {
        if (error) return callback(error);

        result.forEach(function (app) {
            if (app.installationState === appdb.ISTATE_INSTALLED && app.runState === appdb.RSTATE_RUNNING) return;
            if (app.installationState === appdb.ISTATE_ERROR) return;

            debug('Creating process for %s (%s) with state %s', app.fqdn, app.id, app.installationState);
            restartAppTask(app.id, NOOP_CALLBACK); // restart because the auto-installer could have queued up tasks already
        });

        callback(null);
    });
}

function pauseTasks(callback) {
    assert.strictEqual(typeof callback, 'function');

    gPendingTasks = [ ]; // clear this first, otherwise stopAppTask will resume them

    locker.removeListener('unlocked', startNextTask);

    gPaused = true;

    async.eachSeries(Object.keys(gActiveTasks), stopAppTask, callback);
}

function stopPendingTasks(callback) {
    assert.strictEqual(typeof callback, 'function');

    gPendingTasks = [];

    async.eachSeries(Object.keys(gActiveTasks), stopAppTask, callback);
}

function waitForPendingTasks(callback) {
    assert.strictEqual(typeof callback, 'function');

    function checkTasks() {
        if (Object.keys(gActiveTasks).length === 0 && gPendingTasks.length === 0) return callback();
        setTimeout(checkTasks, 1000);
    }

    checkTasks();
}

function startNextTask() {
    if (gPendingTasks.length === 0) return;

    assert(Object.keys(gActiveTasks).length < TASK_CONCURRENCY);

    startAppTask(gPendingTasks.shift(), NOOP_CALLBACK);
}

// WARNING callback has to be called in sync for the concurrency check to work!
function startAppTask(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (appId in gActiveTasks) {
        return callback(new Error(util.format('Task for %s is already active', appId)));
    }

    if (gPaused) {
        debug('Platform not ready yet, queueing task for %s', appId);
        gPendingTasks.push(appId);
        return callback();
    }

    if (Object.keys(gActiveTasks).length >= TASK_CONCURRENCY) {
        debug('Reached concurrency limit, queueing task for %s', appId);
        gPendingTasks.push(appId);
        return callback();
    }

    var lockError = locker.recursiveLock(locker.OP_APPTASK);

    if (lockError) {
        debug('Locked for another operation, queueing task for %s', appId);
        gPendingTasks.push(appId);
        return callback();
    }

    var logFilePath = path.join(paths.LOG_DIR, appId, 'apptask.log');
    var fd;

    // have to use sync here to avoid async callback, breaking concurrency check
    try {
        mkdirp.sync(path.join(paths.LOG_DIR, appId)); // ensure log folder
        fd = fs.openSync(logFilePath, 'a'); // will autoclose
    } catch (e) {
        debug('Unable to get log filedescriptor, queueing task for %s', appId, e);
        gPendingTasks.push(appId);
        return callback();
    }

    // when parent process dies, apptask processes are killed because KillMode=control-group in systemd unit file
    gActiveTasks[appId] = child_process.fork(__dirname + '/apptask.js', [ appId ], { stdio: [ 'pipe', fd, fd, 'ipc' ]});

    var pid = gActiveTasks[appId].pid;
    debug('Started task of %s pid: %s. See logs at %s', appId, pid, logFilePath);

    gActiveTasks[appId].once('exit', function (code, signal) {
        debug('Task for %s pid %s completed with status %s', appId, pid, code);
        if (code === null /* signal */ || (code !== 0 && code !== 50)) { // apptask crashed
            debug('Apptask crashed with code %s and signal %s', code, signal);
            appdb.update(appId, { installationState: appdb.ISTATE_ERROR, installationProgress: 'Apptask crashed with code ' + code + ' and signal ' + signal }, NOOP_CALLBACK);
            eventlog.add(eventlog.ACTION_APP_TASK_CRASH, AUDIT_SOURCE, { appId: appId, crashLogFile: logFilePath }, NOOP_CALLBACK);
        } else if (code === 50) { // task exited cleanly but with an error
            eventlog.add(eventlog.ACTION_APP_TASK_CRASH, AUDIT_SOURCE, { appId: appId, crashLogFile: logFilePath }, NOOP_CALLBACK);
        }
        delete gActiveTasks[appId];
        locker.unlock(locker.OP_APPTASK); // unlock event will trigger next task
    });

    callback();
}

function stopAppTask(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (gActiveTasks[appId]) {
        debug('stopAppTask : Killing existing task of %s with pid %s', appId, gActiveTasks[appId].pid);
        gActiveTasks[appId].once('exit', function () { callback(); });
        gActiveTasks[appId].kill('SIGTERM'); // this will end up calling the 'exit' handler
        return;
    }

    if (gPendingTasks.indexOf(appId) !== -1) {
        debug('stopAppTask: Removing pending task : %s', appId);
        gPendingTasks = _.without(gPendingTasks, appId);
    } else {
        debug('stopAppTask: no task for %s to be stopped', appId);
    }

    callback();
}

function restartAppTask(appId, callback) {
    callback = callback || NOOP_CALLBACK;

    async.series([
        stopAppTask.bind(null, appId),
        startAppTask.bind(null, appId)
    ], callback);
}
