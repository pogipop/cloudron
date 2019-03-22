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
    fs = require('fs'),
    nock = require('nock'),
    paths = require('../../paths.js'),
    server = require('../../server.js'),
    settings = require('../../settings.js'),
    superagent = require('superagent');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;

function setup(done) {
    config._reset();
    config.setFqdn('example-settings-test.com');
    config.setAdminFqdn('my.example-settings-test.com');

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

describe('Settings API', function () {
    before(setup);
    after(cleanup);

    describe('app_autoupdate_pattern', function () {
        it('can get app auto update pattern (default)', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/app_autoupdate_pattern')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.pattern).to.be.ok();
                    done();
                });
        });

        it('cannot set app_autoupdate_pattern without pattern', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/app_autoupdate_pattern')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('can set app_autoupdate_pattern', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/app_autoupdate_pattern')
                .query({ access_token: token })
                .send({ pattern: '00 30 11 * * 1-5' })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    done();
                });
        });

        it('can get app auto update pattern', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/app_autoupdate_pattern')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.pattern).to.be('00 30 11 * * 1-5');
                    done();
                });
        });

        it('can set app_autoupdate_pattern to never', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/app_autoupdate_pattern')
                .query({ access_token: token })
                .send({ pattern: constants.AUTOUPDATE_PATTERN_NEVER })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    done();
                });
        });

        it('can get app auto update pattern', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/app_autoupdate_pattern')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.pattern).to.be(constants.AUTOUPDATE_PATTERN_NEVER);
                    done();
                });
        });

        it('cannot set invalid app_autoupdate_pattern', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/app_autoupdate_pattern')
                .query({ access_token: token })
                .send({ pattern: '1 3 x 5 6' })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });
    });

    describe('box_autoupdate_pattern', function () {
        it('can get app auto update pattern (default)', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/box_autoupdate_pattern')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.pattern).to.be.ok();
                    done();
                });
        });

        it('cannot set box_autoupdate_pattern without pattern', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/box_autoupdate_pattern')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('can set box_autoupdate_pattern', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/box_autoupdate_pattern')
                .query({ access_token: token })
                .send({ pattern: '00 30 11 * * 1-5' })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    done();
                });
        });

        it('can get app auto update pattern', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/box_autoupdate_pattern')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.pattern).to.be('00 30 11 * * 1-5');
                    done();
                });
        });

        it('can set box_autoupdate_pattern to never', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/box_autoupdate_pattern')
                .query({ access_token: token })
                .send({ pattern: constants.AUTOUPDATE_PATTERN_NEVER })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    done();
                });
        });

        it('can get app auto update pattern', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/box_autoupdate_pattern')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.pattern).to.be(constants.AUTOUPDATE_PATTERN_NEVER);
                    done();
                });
        });

        it('cannot set invalid box_autoupdate_pattern', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/box_autoupdate_pattern')
                .query({ access_token: token })
                .send({ pattern: '1 3 x 5 6' })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });
    });

    describe('cloudron_name', function () {
        var name = 'foobar';

        it('get default succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/cloudron_name')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.name).to.be.ok();
                    done();
                });
        });

        it('cannot set without name', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/cloudron_name')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot set empty name', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/cloudron_name')
                .query({ access_token: token })
                .send({ name: '' })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('set succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/cloudron_name')
                .query({ access_token: token })
                .send({ name: name })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);
                    done();
                });
        });

        it('get succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/cloudron_name')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.name).to.eql(name);
                    done();
                });
        });
    });

    describe('cloudron_avatar', function () {
        it('get default succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/cloudron_avatar')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body).to.be.a(Buffer);
                    done();
                });
        });

        it('cannot set without data', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/cloudron_avatar')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('set succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/cloudron_avatar')
                .query({ access_token: token })
                .attach('avatar', paths.CLOUDRON_DEFAULT_AVATAR_FILE)
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);
                    done();
                });
        });

        it('get succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/cloudron_avatar')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.toString()).to.eql(fs.readFileSync(paths.CLOUDRON_DEFAULT_AVATAR_FILE, 'utf-8'));
                    done(err);
                });
        });
    });

    describe('time_zone', function () {
        it('succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/time_zone')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.timeZone).to.be('America/Los_Angeles');
                    done();
                });
        });
    });

    describe('appstore_config', function () {
        it('get appstore_config fails', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/appstore_config')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body).to.eql({});
                    done();
                });
        });

        it('cannot set without data', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/appstore_config')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('set fails with wrong appstore token', function (done) {
            var scope = nock(config.apiServerOrigin()).post('/api/v1/users/nebulon/cloudrons?accessToken=sometoken').reply(401);

            superagent.post(SERVER_URL + '/api/v1/settings/appstore_config')
                .query({ access_token: token })
                .send({ userId: 'nebulon', token: 'sometoken' })
                .end(function (err, res) {
                    expect(scope.isDone()).to.be.ok();
                    expect(res.statusCode).to.equal(424);
                    expect(res.body.message).to.equal('invalid appstore token');

                    done();
                });
        });

        it('set succeeds for unknown cloudron', function (done) {
            var scope = nock(config.apiServerOrigin()).post('/api/v1/users/nebulon/cloudrons?accessToken=sometoken').reply(201, { cloudron: { id: 'cloudron0' }});

            superagent.post(SERVER_URL + '/api/v1/settings/appstore_config')
                .query({ access_token: token })
                .send({ userId: 'nebulon', token: 'sometoken' })
                .end(function (err, res) {
                    expect(scope.isDone()).to.be.ok();
                    expect(res.statusCode).to.equal(202);
                    expect(res.body).to.eql({ userId: 'nebulon', token: 'sometoken', cloudronId: 'cloudron0' });

                    done();
                });
        });

        it('set fails with wrong appstore user', function (done) {
            var scope = nock(config.apiServerOrigin()).get('/api/v1/users/nebulon/cloudrons/cloudron0?accessToken=sometoken').reply(403);

            superagent.post(SERVER_URL + '/api/v1/settings/appstore_config')
                .query({ access_token: token })
                .send({ userId: 'nebulon', token: 'sometoken' })
                .end(function (err, res) {
                    expect(scope.isDone()).to.be.ok();
                    expect(res.statusCode).to.equal(424);
                    expect(res.body.message).to.equal('wrong user');

                    done();
                });
        });

        it('get succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/settings/appstore_config')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body).to.eql({ userId: 'nebulon', token: 'sometoken', cloudronId: 'cloudron0' });
                    done();
                });
        });

        it('set succeeds with cloudronId', function (done) {
            var scope = nock(config.apiServerOrigin()).get('/api/v1/users/nebulon/cloudrons/cloudron0?accessToken=someothertoken').reply(200, { cloudron: { id: 'cloudron0' }});

            superagent.post(SERVER_URL + '/api/v1/settings/appstore_config')
                .query({ access_token: token })
                .send({ userId: 'nebulon', token: 'someothertoken' })
                .end(function (err, res) {
                    expect(scope.isDone()).to.be.ok();
                    expect(res.statusCode).to.equal(202);
                    expect(res.body).to.eql({ userId: 'nebulon', token: 'someothertoken', cloudronId: 'cloudron0' });

                    done();
                });
        });

        it('set succeeds with cloudronId but unkown one (reregister)', function (done) {
            var scope0 = nock(config.apiServerOrigin()).get('/api/v1/users/nebulon/cloudrons/cloudron0?accessToken=someothertoken').reply(404);
            var scope1 = nock(config.apiServerOrigin()).post('/api/v1/users/nebulon/cloudrons?accessToken=someothertoken').reply(201, { cloudron: { id: 'cloudron1' }});

            superagent.post(SERVER_URL + '/api/v1/settings/appstore_config')
                .query({ access_token: token })
                .send({ userId: 'nebulon', token: 'someothertoken' })
                .end(function (err, res) {
                    expect(scope0.isDone()).to.be.ok();
                    expect(scope1.isDone()).to.be.ok();
                    expect(res.statusCode).to.equal(202);
                    expect(res.body).to.eql({ userId: 'nebulon', token: 'someothertoken', cloudronId: 'cloudron1' });

                    done();
                });
        });
    });
});
