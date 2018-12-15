'use strict';

exports = module.exports = {
    get: get,
    update: update,
    listByTypePaged: listByTypePaged,

    getLogs: getLogs,

    startTask: startTask,
    stopTask: stopTask,

    removePrivateFields: removePrivateFields,

    TaskError: TaskError,

    // task types. if you add a task here, fill up the function table in taskworker
    TASK_BACKUP: 'backup',
    TASK_UPDATE: 'update',
    TASK_RENEW_CERTS: 'renewcerts',
    TASK_DASHBOARD_DNS: 'dashboardDns',

    // testing
    _TASK_IDENTITY: '_identity',
    _TASK_CRASH: '_crash',
    _TASK_ERROR: '_error',
    _TASK_SLEEP: '_sleep'
};

let assert = require('assert'),
    child_process = require('child_process'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:tasks'),
    EventEmitter = require('events'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    spawn = require('child_process').spawn,
    split = require('split'),
    taskdb = require('./taskdb.js'),
    util = require('util'),
    _ = require('underscore');

const NOOP_CALLBACK = function (error) { if (error) debug(error); };

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

    taskdb.get(id, function (error, task) {
        if (error && error.reason == DatabaseError.NOT_FOUND) return callback(new TaskError(TaskError.NOT_FOUND));
        if (error) return callback(new TaskError(TaskError.INTERNAL_ERROR, error));

        task.active = !!gTasks[id];

        callback(null, task);
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

function startTask(type, args) {
    assert.strictEqual(typeof type, 'string');
    assert(Array.isArray(args));

    let events = new EventEmitter();

    taskdb.add({ type: type, percent: 0, message: 'Starting', args: args }, function (error, taskId) {
        if (error) return events.emit('error', new TaskError(TaskError.INTERNAL_ERROR, error));

        const logFile = `${paths.TASKS_LOG_DIR}/${taskId}.log`;
        let fd = safe.fs.openSync(logFile, 'w'); // will autoclose
        if (!fd) {
            debug(`startTask: unable to get log filedescriptor ${safe.error.message}`);
            return events.emit('error', new TaskError(TaskError.INTERNAL_ERROR, error.message));
        }

        debug(`startTask - starting task ${type}. logs at ${logFile} id ${taskId}`);

        gTasks[taskId] = child_process.fork(`${__dirname}/taskworker.js`, [ taskId ], { stdio: [ 'pipe', fd, fd, 'ipc' ]}); // fork requires ipc
        gTasks[taskId].once('exit', function (code, signal) {
            debug(`startTask: ${taskId} completed with code ${code} and signal ${signal}`);

            get(taskId, function (error, task) {
                if (!error && task.percent !== 100) { // task crashed or was killed by us (code 50)
                    error = code === 0 ? new Error(`${taskId} task stopped`) : new Error(`${taskId} task crashed with code ${code} and signal ${signal}`);
                    update(taskId, { percent: 100, errorMessage: error.message }, NOOP_CALLBACK);
                } else if (!error && task.errorMessage) {
                    error = new Error(task.errorMessage);
                } else if (!task) { // db got cleared in tests
                    error = new Error(`No such task ${taskId}`);
                }

                gTasks[taskId] = null;

                events.emit('finish', error, task ? task.result : null);

                debug(`startTask: ${taskId} done`);
            });
        });

        events.emit('start', taskId);
    });

    return events;
}

function stopTask(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!gTasks[id]) return callback(new TaskError(TaskError.BAD_STATE, 'task is not active'));

    debug(`stopTask: stopping task ${id}`);

    gTasks[id].kill('SIGTERM'); // this will end up calling the 'exit' signal handler

    callback(null);
}

function listByTypePaged(type, page, perPage, callback) {
    assert(typeof type === 'string' || type === null);
    assert.strictEqual(typeof page, 'number');
    assert.strictEqual(typeof perPage, 'number');
    assert.strictEqual(typeof callback, 'function');

    taskdb.listByTypePaged(type, page, perPage, function (error, tasks) {
        if (error) return callback(new TaskError(TaskError.INTERNAL_ERROR, error));

        tasks.forEach((task) => { task.active = !!gTasks[task.id]; });

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

// removes all fields that are strictly private and should never be returned by API calls
function removePrivateFields(task) {
    var result = _.pick(task, 'id', 'type', 'percent', 'message', 'errorMessage', 'active', 'creationTime', 'result', 'ts');
    return result;
}
