'use strict';

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

var async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    superagent = require('superagent'),
    server = require('../../server.js');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;
var DOMAIN = 'example-domains-test.com';

var DOMAIN_0 = {
    domain: 'cloudron.com',
    zoneName: 'cloudron.com',
    provider: 'noop',
    config: { }
};

var DOMAIN_1 = {
    domain: 'foobar.com',
    provider: 'noop',
    config: { }
};

describe('Domains API', function () {
    this.timeout(10000);

    before(function (done) {
        config._reset();
        config.setFqdn(DOMAIN);

        async.series([
            server.start.bind(null),
            database._clear.bind(null),

            function (callback) {
                superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                    .query({ setupToken: 'somesetuptoken' })
                    .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                    .end(function (error, result) {
                        expect(result).to.be.ok();
                        expect(result.statusCode).to.equal(201);

                        // stash token for further use
                        token = result.body.token;

                        callback();
                    });
            },
        ], done);
    });

    after(function (done) {
        async.series([
            database._clear.bind(null),
            server.stop.bind(null)
        ], done);
    });

    describe('add', function () {
        it('fails with missing domain', function (done) {
            superagent.post(SERVER_URL + '/api/v1/domains')
                .query({ access_token: token })
                .send({})
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);

                    done();
                });
        });

        it('fails with invalid domain', function (done) {
            superagent.post(SERVER_URL + '/api/v1/domains')
                .query({ access_token: token })
                .send({ domain: 'abc' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);

                    done();
                });
        });

        it('fails with unknown provider', function (done) {
            superagent.post(SERVER_URL + '/api/v1/domains')
                .query({ access_token: token })
                .send({ domain: 'cloudron.com', provider: 'doesnotexist', config: { }})
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);

                    done();
                });
        });

        it('succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/domains')
                .query({ access_token: token })
                .send(DOMAIN_0)
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(201);

                    done();
                });
        });

        it('succeeds for second domain without zoneName', function (done) {
            superagent.post(SERVER_URL + '/api/v1/domains')
                .query({ access_token: token })
                .send(DOMAIN_1)
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(201);

                    done();
                });
        });

        it('fails for already added domain', function (done) {
            superagent.post(SERVER_URL + '/api/v1/domains')
                .query({ access_token: token })
                .send(DOMAIN_0)
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(409);

                    done();
                });
        });
    });

    describe('list', function () {
        it('succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/domains')
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(result.body.domains).to.be.an(Array);
                    expect(result.body.domains.length).to.equal(2);

                    expect(result.body.domains[0].domain).to.equal(DOMAIN_0.domain);
                    expect(result.body.domains[1].domain).to.equal(DOMAIN_1.domain);

                    done();
                });
        });
    });

    describe('get', function () {
        it('fails for non-existing domain', function (done) {
            superagent.get(SERVER_URL + '/api/v1/domains/' + DOMAIN_0.domain + DOMAIN_0.domain)
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(404);

                    done();
                });
        });

        it('succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/domains/' + DOMAIN_0.domain)
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(result.body.domain).to.equal(DOMAIN_0.domain);

                    done();
                });
        });
    });

    describe('delete', function () {
        it('fails without password', function (done) {
            superagent.delete(SERVER_URL + '/api/v1/domains/' + DOMAIN_0.domain + DOMAIN_0.domain)
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);

                    done();
                });
        });

        it('fails with wrong password', function (done) {
            superagent.delete(SERVER_URL + '/api/v1/domains/' + DOMAIN_0.domain + DOMAIN_0.domain)
                .query({ access_token: token })
                .send({ password: PASSWORD + PASSWORD })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(403);

                    done();
                });
        });

        it('fails for non-existing domain', function (done) {
            superagent.delete(SERVER_URL + '/api/v1/domains/' + DOMAIN_0.domain + DOMAIN_0.domain)
                .query({ access_token: token })
                .send({ password: PASSWORD })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(404);

                    done();
                });
        });

        it('succeeds', function (done) {
            superagent.delete(SERVER_URL + '/api/v1/domains/' + DOMAIN_0.domain)
                .query({ access_token: token })
                .send({ password: PASSWORD })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(204);

                    superagent.get(SERVER_URL + '/api/v1/domains/' + DOMAIN_0.domain)
                        .query({ access_token: token })
                        .end(function (error, result) {
                            expect(result.statusCode).to.equal(404);

                            done();
                        });
                });
        });
    });
});
