'use strict';

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

var async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    nock = require('nock'),
    superagent = require('superagent'),
    server = require('../../server.js');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;

var DOMAIN_0 = {
    domain: 'cloudron.com',
    zoneName: 'cloudron.com',
    config: { provider: 'noop' }
};

var DOMAIN_1 = {
    domain: 'foobar.com',
    config: { provider: 'noop' }
};

describe('Domains API', function () {
    this.timeout(10000);

    before(function (done) {
        // we test digitalocean here
        config.set('provider', 'digitalocean');
        config.set('fqdn', 'example.com');

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
            var scope = nock(config.apiServerOrigin()).get('/api/v1/helper/public_ip').reply(200, { ip: '127.0.0.1' });

            superagent.post(SERVER_URL + '/api/v1/domains')
                    .query({ access_token: token })
                    .send({ domain: 'cloudron.com', config: { provider: 'doesnotexist' }})
                    .end(function (error, result) {
                expect(result.statusCode).to.equal(400);
                expect(scope.isDone()).to.be.ok();

                done();
            });
        });

        it('succeeds', function (done) {
            var scope = nock(config.apiServerOrigin()).get('/api/v1/helper/public_ip').reply(200, { ip: '127.0.0.1' });

            superagent.post(SERVER_URL + '/api/v1/domains')
                    .query({ access_token: token })
                    .send(DOMAIN_0)
                    .end(function (error, result) {
                expect(result.statusCode).to.equal(201);
                expect(scope.isDone()).to.be.ok();

                done();
            });
        });

        it('succeeds for second domain without zoneName', function (done) {
            var scope = nock(config.apiServerOrigin()).get('/api/v1/helper/public_ip').reply(200, { ip: '127.0.0.1' });

            superagent.post(SERVER_URL + '/api/v1/domains')
                    .query({ access_token: token })
                    .send(DOMAIN_1)
                    .end(function (error, result) {
                expect(result.statusCode).to.equal(201);
                expect(scope.isDone()).to.be.ok();

                done();
            });
        });

        it('fails for already added domain', function (done) {
            var scope = nock(config.apiServerOrigin()).get('/api/v1/helper/public_ip').reply(200, { ip: '127.0.0.1' });

            superagent.post(SERVER_URL + '/api/v1/domains')
                    .query({ access_token: token })
                    .send(DOMAIN_0)
                    .end(function (error, result) {
                expect(result.statusCode).to.equal(409);
                expect(scope.isDone()).to.be.ok();

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
                // includes currently the implicitly added config.fqdn()
                expect(result.body.domains.length).to.equal(3);

                expect(result.body.domains[0].domain).to.equal(DOMAIN_0.domain);
                expect(result.body.domains[1].domain).to.equal(config.fqdn());
                expect(result.body.domains[2].domain).to.equal(DOMAIN_1.domain);

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
