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

describe('Subscription API', function () {
    before(setup);
    after(cleanup);

    it('can setup subscription - no signup', function (done) {
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

    it('can setup subscription - signup', function (done) {
        var scope1 = nock(config.apiServerOrigin())
            .post('/api/v1/register_user', (body) => body.email && body.password)
            .reply(201, { });

        var scope2 = nock(config.apiServerOrigin())
            .post('/api/v1/login', (body) => body.email && body.password)
            .reply(200, { userId: 'userId', accessToken: 'SECRET_TOKEN' });

        var scope3 = nock(config.apiServerOrigin())
            .post('/api/v1/register_cloudron?accessToken=SECRET_TOKEN', (body) => !!body.domain)
            .reply(201, { cloudronId: 'cid', cloudronToken: 'CLOUDRON_TOKEN', licenseKey: 'lkey' });

        superagent.post(SERVER_URL + '/api/v1/subscription')
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
        var scope1 = nock(config.apiServerOrigin())
            .get('/api/v1/subscription?accessToken=CLOUDRON_TOKEN', () => true)
            .reply(200, { subscription: { plan: { id: 'free' } }, email: 'test@cloudron.io' });

        superagent.get(SERVER_URL + '/api/v1/subscription')
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
