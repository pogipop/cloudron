/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    nock = require('nock'),
    path = require('path'),
    safe = require('safetydance'),
    settings = require('../../settings.js'),
    settingsdb = require('../../settingsdb.js'),
    superagent = require('superagent'),
    server = require('../../server.js');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var AUTHORIZED_KEYS_FILE = path.join(config.baseDir(), 'authorized_keys');
var token = null;

function setup(done) {
    nock.cleanAll();
    config._reset();
    config.setFqdn('example-ssh-test.com');
    safe.fs.unlinkSync(AUTHORIZED_KEYS_FILE);

    async.series([
        server.start.bind(server),

        database._clear,

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
        },

        settingsdb.set.bind(null, settings.CLOUDRON_TOKEN_KEY, 'CLOUDRON_TOKEN')
    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(error).to.not.be.ok();

        config._reset();

        server.stop(done);
    });
}

describe('Support API', function () {
    describe('remote support', function () {
        before(setup);
        after(cleanup);

        it('get remote support', function (done) {
            superagent.get(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.enabled).to.be(false);
                    done();
                });
        });

        it('enable remote support', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .send({ enable: true })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);

                    let data = safe.fs.readFileSync(AUTHORIZED_KEYS_FILE, 'utf8');
                    let count = (data.match(/support@cloudron.io/g) || []).length;
                    expect(count).to.be(1);
                    done();
                });
        });

        it('returns true when remote support enabled', function (done) {
            superagent.get(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.enabled).to.be(true);
                    done();
                });
        });

        it('enable remote support (again)', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .send({ enable: true })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);

                    let data = safe.fs.readFileSync(AUTHORIZED_KEYS_FILE, 'utf8');
                    let count = (data.match(/support@cloudron.io/g) || []).length;
                    expect(count).to.be(1);
                    done();
                });
        });

        it('disable remote support', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .send({ enable: false })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);

                    let data = safe.fs.readFileSync(AUTHORIZED_KEYS_FILE, 'utf8');
                    let count = (data.match(/support@cloudron.io/g) || []).length;
                    expect(count).to.be(0);
                    done();
                });
        });

        it('disable remote support (again)', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .send({ enable: false })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);

                    let data = safe.fs.readFileSync(AUTHORIZED_KEYS_FILE, 'utf8');
                    let count = (data.match(/support@cloudron.io/g) || []).length;
                    expect(count).to.be(0);
                    done();
                });
        });
    });

    describe('feedback', function () {
        before(setup);
        after(cleanup);

        it('fails without token', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/feedback')
                .send({ type: 'ticket', subject: 'some subject', description: 'some description' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('fails without type', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/feedback')
                .send({ subject: 'some subject', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails with empty type', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/feedback')
                .send({ type: '', subject: 'some subject', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails with unknown type', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/feedback')
                .send({ type: 'foobar', subject: 'some subject', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails without description', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/feedback')
                .send({ type: 'ticket', subject: 'some subject' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails with empty subject', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/feedback')
                .send({ type: 'ticket', subject: '', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails with empty description', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/feedback')
                .send({ type: 'ticket', subject: 'some subject', description: '' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails without subject', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/feedback')
                .send({ type: 'ticket', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('succeeds with ticket type', function (done) {
            var scope2 = nock(config.apiServerOrigin())
                .filteringRequestBody(function (/* unusedBody */) { return ''; }) // strip out body
                .post('/api/v1/feedback?accessToken=CLOUDRON_TOKEN')
                .reply(201, { });

            superagent.post(SERVER_URL + '/api/v1/support/feedback')
                .send({ type: 'ticket', subject: 'some subject', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(201);
                    expect(scope2.isDone()).to.be.ok();
                    done();
                });
        });

        it('succeeds with app type', function (done) {
            var scope2 = nock(config.apiServerOrigin())
                .filteringRequestBody(function (/* unusedBody */) { return ''; }) // strip out body
                .post('/api/v1/feedback?accessToken=CLOUDRON_TOKEN')
                .reply(201, { });

            superagent.post(SERVER_URL + '/api/v1/support/feedback')
                .send({ type: 'app_missing', subject: 'some subject', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(201);
                    expect(scope2.isDone()).to.be.ok();
                    done();
                });
        });
    });
});
