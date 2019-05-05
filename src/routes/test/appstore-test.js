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
        }
    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(error).to.not.be.ok();

        config._reset();

        server.stop(done);
    });
}

describe('Appstore API', function () {
    before(setup);
    after(cleanup);

    it('cannot list apps without subscription', function (done) {
        superagent.get(SERVER_URL + '/api/v1/appstore/apps')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(402); // billing required
                done();
            });
    });

    it('cannot get app without subscription', function (done) {
        superagent.get(SERVER_URL + '/api/v1/appstore/apps/org.wordpress.cloudronapp')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(402); // billing required
                done();
            });
    });

    it('setup subscription', function (done) {
        var scope1 = nock(config.apiServerOrigin())
            .post('/api/v1/login', (body) => body.email && body.password)
            .reply(200, { userId: 'userId', accessToken: 'SECRET_TOKEN' });

        var scope2 = nock(config.apiServerOrigin())
            .post('/api/v1/register_cloudron?accessToken=SECRET_TOKEN', (body) => !!body.domain)
            .reply(201, { cloudronId: 'cid', cloudronToken: 'CLOUDRON_TOKEN', licenseKey: 'lkey' });

        superagent.post(SERVER_URL + '/api/v1/subscription')
            .send({ email: 'test@cloudron.io', password: 'secret', signup: false })
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(201);
                expect(scope1.isDone()).to.be.ok();
                expect(scope2.isDone()).to.be.ok();
                done();
            });
    });

    it('can list apps', function (done) {
        var scope1 = nock(config.apiServerOrigin())
            .get(`/api/v1/apps?accessToken=CLOUDRON_TOKEN&boxVersion=${config.version()}&unstable=false`, () => true)
            .reply(200, { apps: [] });

        superagent.get(SERVER_URL + '/api/v1/appstore/apps')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                expect(scope1.isDone()).to.be.ok();
                done();
            });
    });

    it('can get app', function (done) {
        var scope1 = nock(config.apiServerOrigin())
            .get('/api/v1/apps/org.wordpress.cloudronapp?accessToken=CLOUDRON_TOKEN', () => true)
            .reply(200, { apps: [] });

        superagent.get(SERVER_URL + '/api/v1/appstore/apps/org.wordpress.cloudronapp')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                expect(scope1.isDone()).to.be.ok();
                done();
            });
    });

    it('can get app version', function (done) {
        var scope1 = nock(config.apiServerOrigin())
            .get('/api/v1/apps/org.wordpress.cloudronapp/versions/3.4.2?accessToken=CLOUDRON_TOKEN', () => true)
            .reply(200, { apps: [] });

        superagent.get(SERVER_URL + '/api/v1/appstore/apps/org.wordpress.cloudronapp/versions/3.4.2')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                expect(scope1.isDone()).to.be.ok();
                done();
            });
    });

});
