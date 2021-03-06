/* jslint node:true */
/* global it:false */
/* global before:false */
/* global after:false */
/* global describe:false */

'use strict';

var async = require('async'),
    database = require('../database.js'),
    expect = require('expect.js'),
    fs = require('fs'),
    paths = require('../paths.js'),
    tasks = require('../tasks.js');

function setup(done) {
    async.series([
        database.initialize,
        database._clear
    ], done);
}

function cleanup(done) {
    async.series([
        database._clear,
        database.uninitialize
    ], done);
}

describe('task', function () {
    before(setup);
    after(cleanup);

    it('can run valid task - success', function (done) {
        let taskId = null;
        let task = tasks.startTask(tasks._TASK_IDENTITY, [ 'ping' ]);
        task.on('error', done);
        task.on('start', (tid) => { taskId = tid; });
        task.on('finish', function (error, result) {
            if (error) return done(error);
            expect(result).to.equal('ping');
            expect(taskId).to.be.ok();
            done();
        });
    });

    it('can run valid task - error', function (done) {
        let taskId = null;
        let task = tasks.startTask(tasks._TASK_ERROR, [ 'ping' ]);
        task.on('error', done);
        task.on('start', (tid) => { taskId = tid; });
        task.on('finish', function (error, result) {
            expect(error).to.be.ok();
            expect(error.message).to.be('Failed for arg: ping');
            expect(result).to.be(null);
            expect(taskId).to.be.ok();
            done();
        });
    });

    it('can get logs of crash', function (done) {
        let taskId = null;
        let task = tasks.startTask(tasks._TASK_CRASH, [ 'ping' ]);
        task.on('error', done);
        task.on('start', (tid) => { taskId = tid; });
        task.on('finish', function (error, result) {
            expect(error).to.be.ok();
            expect(error.message).to.contain(`Task ${taskId} crashed`);
            expect(result).to.be(null);
            expect(taskId).to.be.ok();

            let logs = fs.readFileSync(`${paths.TASKS_LOG_DIR}/${taskId}.log`, 'utf8');
            expect(logs).to.contain('Crashing for arg: ping');
            done();
        });
    });

    it('can stop task', function (done) {
        let taskId = null;
        let task = tasks.startTask(tasks._TASK_SLEEP, [ 10000 ]);
        task.on('error', done);
        task.on('start', (tid) => {
            taskId = tid;
            tasks.stopTask(taskId, () => {});
        });
        task.on('finish', function (error, result) {
            expect(error).to.be.ok();
            expect(error.message).to.contain('SIGTERM');
            expect(result).to.be(null);
            expect(taskId).to.be.ok();
            done();
        });
    });

});
