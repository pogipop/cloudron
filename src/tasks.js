'use strict';

exports = module.exports = {
    update: update,
    get: get,
    clear: clear,

    startTask: startTask,
    stopTask: stopTask,

    TaskError: TaskError,

    TASK_BACKUP: 'backup',
    TASK_UPDATE: 'update',
    TASK_MIGRATE: 'migrate'
};

let assert = require('assert'),
    child_process = require('child_process'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:tasks'),
    eventlog = require('./eventlog.js'),
    locker = require('./locker.js'),
    mailer = require('./mailer.js'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    taskdb = require('./taskdb.js'),
    util = require('util');

const NOOP_CALLBACK = function (error) { if (error) debug(error); };

const TASKS = {
    'backup': {
        lock: locker.OP_FULL_BACKUP,
        logFile: paths.BACKUP_LOG_FILE,
        program: __dirname + '/tasks/backuptask.js',
        onFailure: mailer.backupFailed,
        startEventId: eventlog.ACTION_BACKUP_START,
        finishEventId: eventlog.ACTION_BACKUP_FINISH
    }
};

let gTasks = {};

function TaskError(reason, errorOrMessage) {
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
util.inherits(TaskError, Error);
TaskError.INTERNAL_ERROR = 'Internal Error';
TaskError.BAD_STATE = 'Bad State';
TaskError.NOT_FOUND = 'Not Found';

function update(id, progress, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof progress, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug(`${id}: ${JSON.stringify(progress)}`);

    taskdb.update(id, progress, function (error) {
        if (error) return callback(new TaskError(TaskError.INTERNAL_ERROR, error));

        callback();
    });
}

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    taskdb.get(id, function (error, progress) {
        if (error && error.reason == DatabaseError.NOT_FOUND) return callback(new TaskError(TaskError.NOT_FOUND));
        if (error) return callback(new TaskError(TaskError.INTERNAL_ERROR, error));

        progress.active = !!gTasks[id];

        callback(null, progress);
    });
}

function clear(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    update(id, { percent: 0, message: 'Starting', result: '', errorMessage: '' }, callback);
}

function startTask(id, args, auditSource, callback) {
    assert.strictEqual(typeof id, 'string');
    assert(Array.isArray(args));
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    const taskInfo = TASKS[id];
    if (!taskInfo) return callback(new TaskError(TaskError.NOT_FOUND, 'No such task'));

    let error = locker.lock(taskInfo.lock);
    if (error) return callback(new TaskError(TaskError.BAD_STATE, error.message));

    let fd = safe.fs.openSync(taskInfo.logFile, 'a'); // will autoclose
    if (!fd) {
        debug(`startTask: unable to get log filedescriptor ${safe.error.message}`);
        locker.unlock(taskInfo.lock);
        return callback(new TaskError(TaskError.INTERNAL_ERROR, error.message));
    }

    debug(`startTask - starting task ${id}. logs at ${taskInfo.logFile}`);

    // when parent process dies, this process is killed because KillMode=control-group in systemd unit file
    assert(!gTasks[id], 'Task is already running');

    clear(id, NOOP_CALLBACK);
    eventlog.add(taskInfo.startEventId, auditSource, { });

    gTasks[id] = child_process.fork(taskInfo.program, args, { stdio: [ 'pipe', fd, fd, 'ipc' ]});
    gTasks[id].once('exit', function (code, signal) {
        debug(`startTask: ${id} completed with code ${code} and signal ${signal}`);

        get(id, function (error, progress) {
            if (!error && progress.errorMessage) error = new Error(progress.errorMessage);

            eventlog.add(taskInfo.finishEventId, auditSource, { errorMessage: error ? error.message : null, backupId: progress ? progress.result : null });

            locker.unlock(taskInfo.lock);

            if (error) taskInfo.onFailure(error);

            gTasks[id] = null;

            debug(`startTask: ${id} done`);
        });
    });

    callback(null);
}

function stopTask(id, auditSource, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    const taskInfo = TASKS[id];
    if (!taskInfo) return callback(new TaskError(TaskError.NOT_FOUND, 'No such task'));

    if (!gTasks[id]) return callback(new TaskError(TaskError.BAD_STATE, 'task is not active'));

    debug(`stopTask: stopping task ${id}`);

    gTasks[id].kill('SIGTERM'); // this will end up calling the 'exit' signal handler

    callback(null);
}
