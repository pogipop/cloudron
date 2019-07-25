/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var config = require('../config.js'),
    constants = require('../constants.js'),
    database = require('../database.js'),
    expect = require('expect.js'),
    superagent = require('superagent'),
    server = require('../server.js');

var SERVER_URL = 'http://localhost:' + constants.PORT;
var DOMAIN = 'example-server-test.com';

function cleanup(done) {
    done();
}

describe('Server', function () {
    before(function () {
        config._reset();
        config.setFqdn(DOMAIN);
        config.set('provider', 'digitalocean');
    });

    after(cleanup);

    describe('startup', function () {
        it('start fails due to wrong arguments', function (done) {
            expect(function () { server.start(); }).to.throwException();
            expect(function () { server.start('foobar', function () {}); }).to.throwException();
            expect(function () { server.start(1337, function () {}); }).to.throwException();

            done();
        });

        it('succeeds', function (done) {
            server.start(function (error) {
                expect(error).to.not.be.ok();
                done();
            });
        });

        it('is reachable', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/status', function (err, res) {
                expect(res.statusCode).to.equal(200);
                done(err);
            });
        });

        it('should fail because already running', function (done) {
            expect(server.start).to.throwException(function () {
                done();
            });
        });

        after(function (done) {
            server.stop(function () {
                done();
            });
        });
    });

    describe('runtime', function () {
        before(function (done) {
            server.start(done);
        });

        after(function (done) {
            database._clear(function (error) {
                expect(!error).to.be.ok();
                server.stop(function () {
                    done();
                });
            });
        });

        it('random bad superagents', function (done) {
            superagent.get(SERVER_URL + '/random', function (err, res) {
                expect(err).to.be.ok();
                expect(res.statusCode).to.equal(404);
                done();
            });
        });

        it('version', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/status', function (err, res) {
                expect(err).to.not.be.ok();
                expect(res.statusCode).to.equal(200);
                expect(res.body.version).to.contain('-test');
                done();
            });
        });

        it('status route is GET', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/status')
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(404);

                    superagent.get(SERVER_URL + '/api/v1/cloudron/status')
                        .end(function (err, res) {
                            expect(res.statusCode).to.equal(200);
                            done();
                        });
                });
        });
    });

    describe('config', function () {
        before(function (done) {
            server.start(done);
        });

        after(function (done) {
            server.stop(function () {
                done();
            });
        });

        it('config fails due missing token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/config', function (err, res) {
                expect(res.statusCode).to.equal(401);
                done();
            });
        });

        it('config fails due wrong token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/config').query({ access_token: 'somewrongtoken' }).end(function (err, res) {
                expect(res.statusCode).to.equal(401);
                done();
            });
        });
    });

    describe('shutdown', function () {
        before(function (done) {
            server.start(done);
        });

        it('fails due to wrong arguments', function (done) {
            expect(function () { server.stop(); }).to.throwException();
            expect(function () { server.stop('foobar'); }).to.throwException();
            expect(function () { server.stop(1337); }).to.throwException();
            expect(function () { server.stop({}); }).to.throwException();
            expect(function () { server.stop({ httpServer: {} }); }).to.throwException();

            done();
        });

        it('succeeds', function (done) {
            server.stop(function () {
                done();
            });
        });

        it('is not reachable anymore', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/status', function (error, result) {
                expect(error).to.not.be(null);
                expect(!error.response).to.be.ok();
                done();
            });
        });
    });

    describe('cors', function () {
        before(function (done) {
            server.start(function (error) {
                done(error);
            });
        });

        it('responds to OPTIONS', function (done) {
            superagent('OPTIONS', SERVER_URL + '/api/v1/cloudron/status')
                .set('Access-Control-Request-Method', 'GET')
                .set('Access-Control-Request-Headers', 'accept, origin, x-superagented-with')
                .set('Origin', 'http://localhost')
                .end(function (error, res) {
                    expect(res.headers['access-control-allow-methods']).to.be('GET, PUT, DELETE, POST, OPTIONS');
                    expect(res.headers['access-control-allow-credentials']).to.be('false');
                    expect(res.headers['access-control-allow-headers']).to.be('accept, origin, x-superagented-with'); // mirrored from superagent
                    expect(res.headers['access-control-allow-origin']).to.be('http://localhost'); // mirrors from superagent
                    done();
                });
        });

        it('does not crash for malformed origin', function (done) {
            superagent('OPTIONS', SERVER_URL + '/api/v1/cloudron/status')
                .set('Origin', 'foobar')
                .end(function (error, res) {
                    expect(res.statusCode).to.be(405);
                    done();
                });
        });

        after(function (done) {
            server.stop(function () {
                done();
            });
        });
    });
});
