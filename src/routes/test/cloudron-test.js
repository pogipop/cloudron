'use strict';

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

var accesscontrol = require('../../accesscontrol.js'),
    async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    http = require('http'),
    nock = require('nock'),
    os = require('os'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    settings = require('../../settings.js'),
    settingsdb = require('../../settingsdb.js'),
    tokendb = require('../../tokendb.js');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null; // authentication token
var USERNAME_1 = 'userTheFirst', EMAIL_1 = 'taO@zen.mac', userId_1, token_1;

function setup(done) {
    nock.cleanAll();
    config._reset();
    config.setFqdn('example-cloudron-test.com');
    config.setAdminFqdn('my.example-cloudron-test.com');

    async.series([
        server.start.bind(server),
        database._clear,
        settings.setBackupConfig.bind(null, { provider: 'filesystem', backupFolder: '/tmp', format: 'tgz' }),
        settingsdb.set.bind(null, settings.APPSTORE_CONFIG_KEY, JSON.stringify({ userId: 'USER_ID', cloudronId: 'CLOUDRON_ID', token: 'ACCESS_TOKEN' }))
    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(error).to.not.be.ok();

        config._reset();

        server.stop(done);
    });
}

describe('Cloudron', function () {

    describe('activate', function () {

        before(setup);
        after(cleanup);

        it('fails due to missing setupToken', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .send({ username: '', password: 'somepassword', email: 'admin@foo.bar' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails due to empty username', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: '', password: 'ADSFsdf$%436', email: 'admin@foo.bar' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails due to empty password', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: 'someuser', password: '', email: 'admin@foo.bar' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails due to empty email', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: 'someuser', password: 'ADSF#asd546', email: '' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails due to wrong displayName type', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: 'someuser', password: 'ADSF?#asd546', email: 'admin@foo.bar', displayName: 1234 })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails due to invalid email', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: 'someuser', password: 'ADSF#asd546', email: 'invalidemail' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: 'someuser', password: 'ADSF#asd546', email: 'admin@foo.bar', displayName: 'tester' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(201);
                    done();
                });
        });

        it('fails the second time', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: 'someuser', password: 'ADSF#asd546', email: 'admin@foo.bar' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(409);
                    done();
                });
        });
    });

    describe('get config', function () {
        before(function (done) {
            async.series([
                setup,

                function (callback) {
                    superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                        .query({ setupToken: 'somesetuptoken' })
                        .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                        .end(function (error, result) {
                            expect(result).to.be.ok();

                            // stash token for further use
                            token = result.body.token;

                            callback();
                        });
                },

                function (callback) {
                    superagent.post(SERVER_URL + '/api/v1/users')
                        .query({ access_token: token })
                        .send({ username: USERNAME_1, email: EMAIL_1, invite: false })
                        .end(function (error, result) {
                            expect(result).to.be.ok();
                            expect(result.statusCode).to.eql(201);

                            token_1 = tokendb.generateToken();
                            userId_1 = result.body.id;

                            // HACK to get a token for second user (passwords are generated and the user should have gotten a password setup link...)
                            tokendb.add(token_1, userId_1, 'test-client-id',  Date.now() + 100000, 'cloudron', callback);
                        });
                }
            ], done);
        });

        after(cleanup);

        it('cannot get without token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/config')
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('succeeds (admin)', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/config')
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(result.body.apiServerOrigin).to.eql('http://localhost:6060');
                    expect(result.body.webServerOrigin).to.eql(null);
                    expect(result.body.adminFqdn).to.eql(config.adminFqdn());
                    expect(result.body.progress).to.be.an('object');
                    expect(result.body.update).to.be.an('object');
                    expect(result.body.version).to.eql(config.version());
                    expect(result.body.size).to.eql(null);
                    expect(result.body.region).to.eql(null);
                    expect(result.body.memory).to.eql(os.totalmem());
                    expect(result.body.cloudronName).to.be.a('string');

                    done();
                });
        });

        it('fails (non-admin)', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/config')
                .query({ access_token: token_1 })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(403);
                    done();
                });
        });
    });

    describe('feedback', function () {
        before(function (done) {
            async.series([
                setup,

                function (callback) {
                    superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                        .query({ setupToken: 'somesetuptoken' })
                        .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                        .end(function (error, result) {
                            expect(result).to.be.ok();

                            // stash token for further use
                            token = result.body.token;

                            callback();
                        });
                },
            ], done);
        });

        after(cleanup);

        it('fails without token', function (done) {
            superagent.post(SERVER_URL + '/api/v1/feedback')
                .send({ type: 'ticket', subject: 'some subject', description: 'some description' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('fails without type', function (done) {
            superagent.post(SERVER_URL + '/api/v1/feedback')
                .send({ subject: 'some subject', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails with empty type', function (done) {
            superagent.post(SERVER_URL + '/api/v1/feedback')
                .send({ type: '', subject: 'some subject', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails with unknown type', function (done) {
            superagent.post(SERVER_URL + '/api/v1/feedback')
                .send({ type: 'foobar', subject: 'some subject', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails without description', function (done) {
            superagent.post(SERVER_URL + '/api/v1/feedback')
                .send({ type: 'ticket', subject: 'some subject' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails with empty subject', function (done) {
            superagent.post(SERVER_URL + '/api/v1/feedback')
                .send({ type: 'ticket', subject: '', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails with empty description', function (done) {
            superagent.post(SERVER_URL + '/api/v1/feedback')
                .send({ type: 'ticket', subject: 'some subject', description: '' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails without subject', function (done) {
            superagent.post(SERVER_URL + '/api/v1/feedback')
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
                .post('/api/v1/users/USER_ID/cloudrons/CLOUDRON_ID/feedback?accessToken=ACCESS_TOKEN')
                .reply(201, { });

            superagent.post(SERVER_URL + '/api/v1/feedback')
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
                .post('/api/v1/users/USER_ID/cloudrons/CLOUDRON_ID/feedback?accessToken=ACCESS_TOKEN')
                .reply(201, { });

            superagent.post(SERVER_URL + '/api/v1/feedback')
                .send({ type: 'app_missing', subject: 'some subject', description: 'some description' })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(201);
                    expect(scope2.isDone()).to.be.ok();
                    done();
                });
        });
    });

    describe('logs', function () {
        before(function (done) {
            async.series([
                setup,

                function (callback) {
                    superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                        .query({ setupToken: 'somesetuptoken' })
                        .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                        .end(function (error, result) {
                            expect(result).to.be.ok();

                            // stash token for further use
                            token = result.body.token;

                            callback();
                        });
                },
            ], done);
        });

        after(cleanup);

        it('logStream - requires event-stream accept header', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/logstream/box')
                .query({ access_token: token, fromLine: 0 })
                .end(function (err, res) {
                    expect(res.statusCode).to.be(400);
                    done();
                });
        });

        it('logStream - stream logs', function (done) {
            var options = {
                host: 'localhost',
                port: config.get('port'),
                path: '/api/v1/cloudron/logstream/mail?units=all&lines=10&access_token=' + token,
                headers: { 'Accept': 'text/event-stream', 'Connection': 'keep-alive' }
            };

            // superagent doesn't work. maybe https://github.com/visionmedia/superagent/issues/420
            var req = http.get(options, function (res) {
                var data = '';
                res.on('data', function (d) { data += d.toString('utf8'); });
                setTimeout(function checkData() {
                    var dataMessageFound = false;

                    expect(data.length).to.not.be(0);
                    data.split('\n').forEach(function (line) {
                        if (line.indexOf('id: ') === 0) {
                            expect(parseInt(line.substr('id: '.length), 10)).to.be.a('number');
                        } else if (line.indexOf('data: ') === 0) {
                            var message = JSON.parse(line.slice('data: '.length)).message;
                            if (Array.isArray(message) || typeof message === 'string') dataMessageFound = true;
                        }
                    });

                    expect(dataMessageFound).to.be.ok();

                    req.abort();
                    done();
                }, 1000);
                res.on('error', done);
            });

            req.on('error', done);
        });
    });
});
