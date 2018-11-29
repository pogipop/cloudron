'use strict';

exports = module.exports = {
    setProgress: setProgress,
    getProgress: getProgress,
    clearProgress: clearProgress,

    stopTask: stopTask,

    TaskError: TaskError,

    TASK_BACKUP: 'backup',
    TASK_UPDATE: 'update',
    TASK_MIGRATE: 'migrate'
};

let assert = require('assert'),
    BackupsError = require('./backups.js').BackupsError,
    backups = require('./backups.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:tasks'),
    taskdb = require('./taskdb.js'),
    util = require('util');

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

function setProgress(id, progress, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof progress, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug(`${id}: ${JSON.stringify(progress)}`);

    taskdb.setProgress(id, progress, function (error) {
        if (error) return callback(new TaskError(TaskError.INTERNAL_ERROR, error));

        callback();
    });
}

function getProgress(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    taskdb.getProgress(id, function (error, progress) {
        if (error && error.reason == DatabaseError.NOT_FOUND) return callback(new TaskError(TaskError.NOT_FOUND));
        if (error) return callback(new TaskError(TaskError.INTERNAL_ERROR, error));

        callback(null, progress);
    });
}

function clearProgress(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    setProgress(id, { percent: 0, message: 'Starting', result: '', errorMessage: '' }, callback);
}

function stopTask(id, auditSource, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    switch (id) {
    case exports.TASK_BACKUP:
        backups.stopBackupTask(auditSource, function (error) {
            if (error && error.reason === BackupsError.BAD_STATE) return callback(new TaskError(TaskError.NOT_FOUND));
            if (error) return callback(new TaskError(TaskError.INTERNAL_ERROR, error));

            callback(null);
        });
        break;

    default:
        return callback(new TaskError(TaskError.NOT_FOUND));
    }
}
