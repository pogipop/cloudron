'use strict';

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

let async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    hat = require('../../hat.js'),
    http = require('http'),
    nock = require('nock'),
    os = require('os'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    settings = require('../../settings.js'),
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
        settings.setBackupConfig.bind(null, { provider: 'filesystem', backupFolder: '/tmp', format: 'tgz' })
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

                            token_1 = hat(8 * 32);
                            userId_1 = result.body.id;

                            // HACK to get a token for second user (passwords are generated and the user should have gotten a password setup link...)
                            tokendb.add({ id: 'tid-1', accessToken: token_1, identifier: userId_1, clientId: 'test-client-id', expires: Date.now() + 100000, scope: 'cloudron', name: '' }, callback);
                        });
                }
            ], done);
        });

        after(cleanup);

        it('cannot get without token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/config')
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('succeeds (admin)', function (done) {
            superagent.get(SERVER_URL + '/api/v1/config')
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(result.body.apiServerOrigin).to.eql('http://localhost:6060');
                    expect(result.body.webServerOrigin).to.eql(null);
                    expect(result.body.adminFqdn).to.eql(config.adminFqdn());
                    expect(result.body.version).to.eql(config.version());
                    expect(result.body.memory).to.eql(os.totalmem());
                    expect(result.body.cloudronName).to.be.a('string');

                    done();
                });
        });

        it('fails (non-admin)', function (done) {
            superagent.get(SERVER_URL + '/api/v1/config')
                .query({ access_token: token_1 })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(403);
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
                path: '/api/v1/cloudron/logstream/box?lines=10&access_token=' + token,
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
