'use strict';

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

var async = require('async'),
    config = require('../../config.js'),
    constants = require('../../constants.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    server = require('../../server.js'),
    superagent = require('superagent'),
    tasks = require('../../tasks.js');

var SERVER_URL = 'http://localhost:' + constants.PORT;

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;

function setup(done) {
    config._reset();
    config.setFqdn('example-tasks-test.com');
    config.setAdminFqdn('my.example-tasks-test.com');

    async.series([
        server.start.bind(null),
        database._clear.bind(null),

        function createAdmin(callback) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                .end(function (error, result) {
                    expect(result).to.be.ok();
                    expect(result.statusCode).to.eql(201);

                    // stash token for further use
                    token = result.body.token;

                    callback();
                });
        }
    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(!error).to.be.ok();

        server.stop(done);
    });
}

describe('Tasks API', function () {
    before(setup);
    after(cleanup);

    it('can get task', function (done) {
        let taskId = null;
        let task = tasks.startTask(tasks._TASK_IDENTITY, [ 'ping' ]);
        task.on('error', done);
        task.on('start', (tid) => { taskId = tid; });

        task.on('finish', function () {
            superagent.get(SERVER_URL + '/api/v1/tasks/' + taskId)
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.percent).to.be(100);
                    expect(res.body.args).to.be(undefined);
                    expect(res.body.active).to.be(false); // finished
                    expect(res.body.result).to.be('ping');
                    expect(res.body.errorMessage).to.be(null);
                    done();
                });
        });
    });

    it('can get logs', function (done) {
        let taskId = null;
        let task = tasks.startTask(tasks._TASK_CRASH, [ 'ping' ]);
        task.on('error', done);
        task.on('start', (tid) => { taskId = tid; });

        task.on('finish', function () {
            superagent.get(SERVER_URL + '/api/v1/tasks/' + taskId + '/logs')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    done();
                });
        });
    });

    it('cannot stop inactive task', function (done) {
        let taskId = null;
        let task = tasks.startTask(tasks._TASK_IDENTITY, [ 'ping' ]);
        task.on('error', done);
        task.on('start', (tid) => { taskId = tid; });

        task.on('finish', function () {
            superagent.post(SERVER_URL + '/api/v1/tasks/' + taskId + '/stop')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(409);
                    done();
                });
        });
    });


    it('can stop task', function (done) {
        let taskId = null;
        let task = tasks.startTask(tasks._TASK_SLEEP, [ 10000 ]);
        task.on('error', done);
        task.on('start', (tid) => {
            taskId = tid;
            superagent.post(SERVER_URL + '/api/v1/tasks/' + taskId + '/stop')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(204);
                });
        });
        task.on('finish', () => {
            superagent.get(SERVER_URL + '/api/v1/tasks/' + taskId)
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.percent).to.be(100);
                    expect(res.body.active).to.be(false); // finished
                    expect(res.body.result).to.be(null);
                    expect(res.body.errorMessage).to.contain('signal SIGTERM');
                    done();
                });
        });
    });

    it('can list tasks', function (done) {
        let taskId = null;
        let task = tasks.startTask(tasks._TASK_IDENTITY, [ 'ping' ]);
        task.on('error', done);
        task.on('start', (tid) => { taskId = tid; });

        task.on('finish', function () {
            superagent.get(SERVER_URL + '/api/v1/tasks?type=' + tasks._TASK_IDENTITY)
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.tasks.length >= 1).to.be(true);
                    expect(res.body.tasks[0].id).to.be(taskId);
                    expect(res.body.tasks[0].percent).to.be(100);
                    expect(res.body.tasks[0].args).to.be(undefined);
                    expect(res.body.tasks[0].active).to.be(false); // finished
                    expect(res.body.tasks[0].result).to.be('ping');
                    expect(res.body.tasks[0].errorMessage).to.be(null);
                    done();
                });
        });
    });
});
