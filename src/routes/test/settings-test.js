'use strict';

/* global it:false */
/* global describe:false */
/* global xdescribe:false */
/* global before:false */
/* global after:false */

var async = require('async'),
    child_process = require('child_process'),
    config = require('../../config.js'),
    constants = require('../../constants.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    fs = require('fs'),
    nock = require('nock'),
    path = require('path'),
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
            var eventPattern = null;
            settings.events.on(settings.APP_AUTOUPDATE_PATTERN_KEY, function (pattern) {
                eventPattern = pattern;
            });

            superagent.post(SERVER_URL + '/api/v1/settings/app_autoupdate_pattern')
                .query({ access_token: token })
                .send({ pattern: '00 30 11 * * 1-5' })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(eventPattern === '00 30 11 * * 1-5').to.be.ok();
                    done();
                });
        });

        it('can set app_autoupdate_pattern to never', function (done) {
            var eventPattern = null;
            settings.events.on(settings.APP_AUTOUPDATE_PATTERN_KEY, function (pattern) {
                eventPattern = pattern;
            });

            superagent.post(SERVER_URL + '/api/v1/settings/app_autoupdate_pattern')
                .query({ access_token: token })
                .send({ pattern: constants.AUTOUPDATE_PATTERN_NEVER })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(eventPattern).to.eql(constants.AUTOUPDATE_PATTERN_NEVER);
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
            var eventPattern = null;
            settings.events.on(settings.BOX_AUTOUPDATE_PATTERN_KEY, function (pattern) {
                eventPattern = pattern;
            });

            superagent.post(SERVER_URL + '/api/v1/settings/box_autoupdate_pattern')
                .query({ access_token: token })
                .send({ pattern: '00 30 11 * * 1-5' })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(eventPattern === '00 30 11 * * 1-5').to.be.ok();
                    done();
                });
        });

        it('can set box_autoupdate_pattern to never', function (done) {
            var eventPattern = null;
            settings.events.on(settings.BOX_AUTOUPDATE_PATTERN_KEY, function (pattern) {
                eventPattern = pattern;
            });

            superagent.post(SERVER_URL + '/api/v1/settings/box_autoupdate_pattern')
                .query({ access_token: token })
                .send({ pattern: constants.AUTOUPDATE_PATTERN_NEVER })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(eventPattern).to.eql(constants.AUTOUPDATE_PATTERN_NEVER);
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

    xdescribe('Certificates API', function () {
        var validCert0, validKey0, // example.com
            validCert1, validKey1; // *.example.com

        before(function () {
            child_process.execSync('openssl req -subj "/CN=example.com/O=My Company Name LTD./C=US" -new -newkey rsa:2048 -days 365 -nodes -x509 -keyout /tmp/server.key -out /tmp/server.crt');
            validKey0 = fs.readFileSync('/tmp/server.key', 'utf8');
            validCert0 = fs.readFileSync('/tmp/server.crt', 'utf8');

            child_process.execSync('openssl req -subj "/CN=*.example.com/O=My Company Name LTD./C=US" -new -newkey rsa:2048 -days 365 -nodes -x509 -keyout /tmp/server.key -out /tmp/server.crt');
            validKey1 = fs.readFileSync('/tmp/server.key', 'utf8');
            validCert1 = fs.readFileSync('/tmp/server.crt', 'utf8');
        });

        it('cannot set certificate without token', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/certificate')
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('cannot set certificate without certificate', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/certificate')
                .query({ access_token: token })
                .send({ key: validKey1 })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot set certificate without key', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/certificate')
                .query({ access_token: token })
                .send({ cert: validCert1 })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot set certificate with cert not being a string', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/certificate')
                .query({ access_token: token })
                .send({ cert: 1234, key: validKey1 })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot set certificate with key not being a string', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/certificate')
                .query({ access_token: token })
                .send({ cert: validCert1, key: true })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot set non wildcard certificate', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/certificate')
                .query({ access_token: token })
                .send({ cert: validCert0, key: validKey0 })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('can set certificate', function (done) {
            superagent.post(SERVER_URL + '/api/v1/settings/certificate')
                .query({ access_token: token })
                .send({ cert: validCert1, key: validKey1 })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(202);
                    done();
                });
        });

        it('did set the certificate', function (done) {
            var cert = fs.readFileSync(path.join(paths.NGINX_CERT_DIR, 'host.cert'), 'utf-8');
            expect(cert).to.eql(validCert1);

            var key = fs.readFileSync(path.join(paths.NGINX_CERT_DIR, 'host.key'), 'utf-8');
            expect(key).to.eql(validKey1);

            done();
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
                    expect(res.statusCode).to.equal(406);
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
                    expect(res.statusCode).to.equal(406);
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
