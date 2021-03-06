/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    constants = require('../../constants.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    nock = require('nock'),
    settings = require('../../settings.js'),
    superagent = require('superagent'),
    server = require('../../server.js');

var SERVER_URL = 'http://localhost:' + constants.PORT;

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;

function setup(done) {
    nock.cleanAll();

    async.series([
        server.start.bind(server),

        database._clear,

        settings._setApiServerOrigin.bind(null, 'http://localhost:6060'),
        settings.setAdmin.bind(null, 'appstore-test.example.com', 'my.appstore-test.example.com'),

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

        server.stop(done);
    });
}

describe('Appstore Apps API', function () {
    before(setup);
    after(cleanup);

    it('cannot list apps without subscription', function (done) {
        superagent.get(SERVER_URL + '/api/v1/appstore/apps')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(412); // not registered yet
                done();
            });
    });

    it('cannot get app without subscription', function (done) {
        superagent.get(SERVER_URL + '/api/v1/appstore/apps/org.wordpress.cloudronapp')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(412); // not registered yet
                done();
            });
    });

    it('register cloudron', function (done) {
        var scope1 = nock(settings.apiServerOrigin())
            .post('/api/v1/login', (body) => body.email && body.password)
            .reply(200, { userId: 'userId', accessToken: 'SECRET_TOKEN' });

        var scope2 = nock(settings.apiServerOrigin())
            .post('/api/v1/register_cloudron', (body) => !!body.domain && body.accessToken === 'SECRET_TOKEN')
            .reply(201, { cloudronId: 'cid', cloudronToken: 'CLOUDRON_TOKEN', licenseKey: 'lkey' });

        superagent.post(SERVER_URL + '/api/v1/appstore/register_cloudron')
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
        var scope1 = nock(settings.apiServerOrigin())
            .get(`/api/v1/apps?accessToken=CLOUDRON_TOKEN&boxVersion=${constants.VERSION}&unstable=false`, () => true)
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
        var scope1 = nock(settings.apiServerOrigin())
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
        var scope1 = nock(settings.apiServerOrigin())
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

describe('Subscription API - no signup', function () {
    before(setup);
    after(cleanup);

    it('can setup subscription', function (done) {
        var scope1 = nock(settings.apiServerOrigin())
            .post('/api/v1/login', (body) => body.email && body.password)
            .reply(200, { userId: 'userId', accessToken: 'SECRET_TOKEN' });

        var scope2 = nock(settings.apiServerOrigin())
            .post('/api/v1/register_cloudron', (body) => !!body.domain && body.accessToken === 'SECRET_TOKEN')
            .reply(201, { cloudronId: 'cid', cloudronToken: 'CLOUDRON_TOKEN', licenseKey: 'lkey' });

        superagent.post(SERVER_URL + '/api/v1/appstore/register_cloudron')
            .send({ email: 'test@cloudron.io', password: 'secret', signup: false })
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(201);
                expect(scope1.isDone()).to.be.ok();
                expect(scope2.isDone()).to.be.ok();
                done();
            });
    });

    it('cannot re-setup subscription - already registered', function (done) {
        superagent.post(SERVER_URL + '/api/v1/appstore/register_cloudron')
            .send({ email: 'test@cloudron.io', password: 'secret', signup: false })
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(422);
                done();
            });
    });
});

describe('Subscription API - signup', function () {
    before(setup);
    after(cleanup);

    it('can setup subscription', function (done) {
        var scope1 = nock(settings.apiServerOrigin())
            .post('/api/v1/register_user', (body) => body.email && body.password)
            .reply(201, { });

        var scope2 = nock(settings.apiServerOrigin())
            .post('/api/v1/login', (body) => body.email && body.password)
            .reply(200, { userId: 'userId', accessToken: 'SECRET_TOKEN' });

        var scope3 = nock(settings.apiServerOrigin())
            .post('/api/v1/register_cloudron', (body) => !!body.domain && body.accessToken === 'SECRET_TOKEN')
            .reply(201, { cloudronId: 'cid', cloudronToken: 'CLOUDRON_TOKEN', licenseKey: 'lkey' });

        superagent.post(SERVER_URL + '/api/v1/appstore/register_cloudron')
            .send({ email: 'test@cloudron.io', password: 'secret', signup: true })
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(201);
                expect(scope1.isDone()).to.be.ok();
                expect(scope2.isDone()).to.be.ok();
                expect(scope3.isDone()).to.be.ok();
                done();
            });
    });

    it('can get subscription', function (done) {
        var scope1 = nock(settings.apiServerOrigin())
            .get('/api/v1/subscription?accessToken=CLOUDRON_TOKEN', () => true)
            .reply(200, { subscription: { plan: { id: 'free' } }, email: 'test@cloudron.io' });

        superagent.get(SERVER_URL + '/api/v1/appstore/subscription')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                expect(result.body.email).to.be('test@cloudron.io');
                expect(result.body.subscription).to.be.an('object');
                expect(scope1.isDone()).to.be.ok();
                done();
            });
    });
});
