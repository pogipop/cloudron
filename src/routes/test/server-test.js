/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../../config.js'),
    constants = require('../../constants.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    superagent = require('superagent'),
    server = require('../../server.js');

var SERVER_URL = 'http://localhost:' + constants.PORT;
var DOMAIN = 'example-server-test.com';
var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;

function setup(done) {
    config._reset();

    async.series([
        server.start,
        database._clear
    ], done);
}

function cleanup(done) {
    async.series([
        database._clear,
        server.stop
    ], done);
}

function waitForSetup(done) {
    async.retry({ times: 5, interval: 4000 }, function (retryCallback) {
        superagent.get(SERVER_URL + '/api/v1/cloudron/status')
            .end(function (error, result) {
                if (!result || result.statusCode !== 200) return retryCallback(new Error('Bad result'));

                if (!result.body.setup.active && result.body.setup.errorMessage === '' && result.body.adminFqdn) return retryCallback();

                retryCallback(new Error('Not done yet: ' + JSON.stringify(result.body)));
            });
    }, done);
}

describe('REST API', function () {
    before(setup);
    after(cleanup);

    it('dns setup fails without provider', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
            .send({ dnsConfig: { domain: DOMAIN, config: {} } })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('dns setup fails with invalid provider', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
            .send({ dnsConfig: { provider: 'foobar', domain: DOMAIN, config: {} } })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('dns setup fails with missing domain', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
            .send({ dnsConfig: { provider: 'noop', config: {} } })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('dns setup fails with invalid domain', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
            .send({ dnsConfig: { provider: 'noop', domain: '.foo', config: {} } })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('dns setup fails with invalid config', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
            .send({ dnsConfig: { provider: 'noop', domain: DOMAIN, config: 'not an object' } })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('dns setup fails with invalid zoneName', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
            .send({ dnsConfig: { provider: 'noop', domain: DOMAIN, config: {}, zoneName: 1337 } })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('dns setup fails with invalid tlsConfig', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
            .send({ dnsConfig: { provider: 'noop', domain: DOMAIN, config: {}, tlsConfig: 'foobar' } })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('dns setup fails with invalid tlsConfig provider', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
            .send({ dnsConfig: { provider: 'noop', domain: DOMAIN, config: {}, tlsConfig: { provider: 1337 } } })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('dns setup succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
            .send({ dnsConfig: { provider: 'noop', domain: DOMAIN, adminFqdn: 'my.' + DOMAIN, config: {}, tlsConfig: { provider: 'fallback' } } })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(200);

                waitForSetup(done);
            });
    });

    it('dns setup twice succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
            .send({ dnsConfig: { provider: 'noop', domain: DOMAIN, DOMAIN, config: {} }, tlsConfig: { provider: 'fallback' } })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(200);

                waitForSetup(done);
            });
    });

    it('activation fails without username', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
            .query({ setupToken: 'somesetuptoken' })
            .send({ password: PASSWORD, email: EMAIL })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('activation fails with invalid username', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
            .query({ setupToken: 'somesetuptoken' })
            .send({ username: '?this.is-not!valid', password: PASSWORD, email: EMAIL })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('activation fails without email', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
            .query({ setupToken: 'somesetuptoken' })
            .send({ username: USERNAME, password: PASSWORD })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('activation fails with invalid email', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
            .query({ setupToken: 'somesetuptoken' })
            .send({ username: USERNAME, password: PASSWORD, email: 'notanemail' })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('activation fails without password', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
            .query({ setupToken: 'somesetuptoken' })
            .send({ username: USERNAME, email: EMAIL })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('activation fails with invalid password', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
            .query({ setupToken: 'somesetuptoken' })
            .send({ username: USERNAME, password: 'short', email: EMAIL })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(400);

                done();
            });
    });

    it('activation succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
            .query({ setupToken: 'somesetuptoken' })
            .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(201);

                // stash token for further use
                token = result.body.token;

                done();
            });
    });

    it('activating twice fails', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
            .query({ setupToken: 'somesetuptoken' })
            .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(409);

                done();
            });
    });

    it('dns setup after activation fails', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
            .send({ dnsConfig: { provider: 'noop', domain: DOMAIN, DOMAIN, config: {} } })
            .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(409);

                done();
            });
    });

    it('does not crash with invalid JSON', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .set('content-type', 'application/json')
            .send('some invalid non-strict json')
            .end(function (error, result) {
                expect(result.statusCode).to.equal(400);
                expect(result.body.message).to.be('Failed to parse body');

                done();
            });
    });

    it('does not crash with invalid string', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .set('content-type', 'application/x-www-form-urlencoded')
            .send('some string')
            .end(function (error, result) {
                expect(result.statusCode).to.equal(400);

                done();
            });
    });
});
