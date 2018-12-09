'use strict';

exports = module.exports = {
    get: get,
    update: update,
    listPaged: listPaged,

    getLogs: getLogs,

    startTask: startTask,
    stopTask: stopTask,

    TaskError: TaskError,

    // task types
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
    spawn = require('child_process').spawn,
    split = require('split'),
    taskdb = require('./taskdb.js'),
    util = require('util'),
    _ = require('underscore');

const NOOP_CALLBACK = function (error) { if (error) debug(error); };

const TASKS = { // indexed by task type
    backup: {
        lock: locker.OP_FULL_BACKUP,
        program: __dirname + '/tasks/backuptask.js',
        onFailure: mailer.backupFailed,
        startEventId: eventlog.ACTION_BACKUP_START,
        finishEventId: eventlog.ACTION_BACKUP_FINISH
    },
    update: {
        lock: locker.OP_BOX_UPDATE,
        program: __dirname + '/tasks/updatertask.js',
        onFailure: NOOP_CALLBACK,
        startEventId: eventlog.ACTION_UPDATE,
        finishEventId: eventlog.ACTION_UPDATE
    }
};

let gTasks = {}; // indexed by task id

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

function update(id, task, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof task, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug(`${id}: ${JSON.stringify(task)}`);

    taskdb.update(id, task, function (error) {
        if (error && error.reason == DatabaseError.NOT_FOUND) return callback(new TaskError(TaskError.NOT_FOUND));
        if (error) return callback(new TaskError(TaskError.INTERNAL_ERROR, error));

        callback();
    });
}

function startTask(type, args, auditSource, callback) {
    assert.strictEqual(typeof type, 'string');
    assert(args && typeof args === 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    const taskInfo = TASKS[type];
    if (!taskInfo) return callback(new TaskError(TaskError.NOT_FOUND, 'No such task'));

    let error = locker.lock(taskInfo.lock);
    if (error) return callback(new TaskError(TaskError.BAD_STATE, error.message));

    taskdb.add({ type: type, percent: 0, message: 'Starting', args: args }, function (error, taskId) {
        if (error) return callback(new TaskError(TaskError.INTERNAL_ERROR, error));

        let fd = safe.fs.openSync(`${paths.TASKS_LOG_DIR}/${taskId}.log`, 'a'); // will autoclose
        if (!fd) {
            debug(`startTask: unable to get log filedescriptor ${safe.error.message}`);
            locker.unlock(taskInfo.lock);
            return callback(new TaskError(TaskError.INTERNAL_ERROR, error.message));
        }

        debug(`startTask - starting task ${type}. logs at ${taskInfo.logFile}. id ${taskId}`);

        eventlog.add(taskInfo.startEventId, auditSource, args);

        gTasks[taskId] = child_process.fork(taskInfo.program, [ taskId ], { stdio: [ 'pipe', fd, fd, 'ipc' ]}); // fork requires ipc
        gTasks[taskId].once('exit', function (code, signal) {
            debug(`startTask: ${taskId} completed with code ${code} and signal ${signal}`);

            get(taskId, function (error, task) {
                if (!error && task.percent !== 100) { // task crashed or was killed by us (code 50)
                    error = code === 0 ? new Error(`${taskId} task stopped`) : new Error(`${taskId} task crashed with code ${code} and signal ${signal}`);
                    update(taskId, { percent: 100, errorMessage: error.message }, NOOP_CALLBACK);
                } else if (!error && task.errorMessage) {
                    error = new Error(task.errorMessage);
                }

                eventlog.add(taskInfo.finishEventId, auditSource, _.extend({ errorMessage: error ? error.message : null }, task ? task.result : {}));

                locker.unlock(taskInfo.lock);

                if (error) taskInfo.onFailure(error);

                gTasks[taskId] = null;

                debug(`startTask: ${taskId} done`);
            });
        });

        callback(null, taskId);
    });
}

function stopTask(id, auditSource, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!gTasks[id]) return callback(new TaskError(TaskError.BAD_STATE, 'task is not active'));

    debug(`stopTask: stopping task ${id}`);

    gTasks[id].kill('SIGTERM'); // this will end up calling the 'exit' signal handler

    callback(null);
}

function listPaged(type, page, perPage, callback) {
    assert(typeof type === 'string' || type === null);
    assert.strictEqual(typeof page, 'number');
    assert.strictEqual(typeof perPage, 'number');
    assert.strictEqual(typeof callback, 'function');

    taskdb.listPaged(type, page, perPage, function (error, tasks) {
        if (error) return callback(new TaskError(TaskError.INTERNAL_ERROR, error));

        callback(null, tasks);
    });
}

function getLogs(taskId, options, callback) {
    assert.strictEqual(typeof taskId, 'string');
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    debug(`Getting logs for ${taskId}`);

    var lines = options.lines || 100,
        format = options.format || 'json',
        follow = !!options.follow;

    assert.strictEqual(typeof lines, 'number');
    assert.strictEqual(typeof format, 'string');

    let cmd = '/usr/bin/tail';
    var args = [ '--lines=' + lines ];

    if (follow) args.push('--follow', '--retry', '--quiet'); // same as -F. to make it work if file doesn't exist, --quiet to not output file headers, which are no logs
    args.push(`${paths.TASKS_LOG_DIR}/${taskId}.log`);

    var cp = spawn(cmd, args);

    var transformStream = split(function mapper(line) {
        if (format !== 'json') return line + '\n';

        var data = line.split(' '); // logs are <ISOtimestamp> <msg>
        var timestamp = (new Date(data[0])).getTime();
        if (isNaN(timestamp)) timestamp = 0;
        var message = line.slice(data[0].length+1);

        // ignore faulty empty logs
        if (!timestamp && !message) return;

        return JSON.stringify({
            realtimeTimestamp: timestamp * 1000,
            message: message,
            source: taskId
        }) + '\n';
    });

    transformStream.close = cp.kill.bind(cp, 'SIGKILL'); // closing stream kills the child process

    cp.stdout.pipe(transformStream);

    callback(null, transformStream);
}
