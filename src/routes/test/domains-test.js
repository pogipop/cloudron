'use strict';

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

var async = require('async'),
    child_process = require('child_process'),
    config = require('../../config.js'),
    constants = require('../../constants.js'),
    database = require('../../database.js'),
    domaindb = require('../../domaindb.js'),
    expect = require('expect.js'),
    fs = require('fs'),
    path = require('path'),
    paths = require('../../paths.js'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    _ = require('underscore');

var SERVER_URL = 'http://localhost:' + constants.PORT;

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;
var DOMAIN = 'example-domains-test.com';

var DOMAIN_0 = {
    domain: 'cloudron.com',
    zoneName: 'cloudron.com',
    provider: 'noop',
    config: { },
    tlsConfig: {
        provider: 'fallback'
    }
};

var DOMAIN_1 = {
    domain: 'foobar.com',
    provider: 'noop',
    config: { },
    tlsConfig: {
        provider: 'fallback'
    }
};

describe('Domains API', function () {
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

        it('fails with invalid tlsConfig', function (done) {
            superagent.post(SERVER_URL + '/api/v1/domains')
                .query({ access_token: token })
                .send({ domain: 'cloudron.com', provider: 'noop', config: { }, tlsConfig: 'foobar' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);

                    done();
                });
        });

        it('fails with unknown tls provider', function (done) {
            superagent.post(SERVER_URL + '/api/v1/domains')
                .query({ access_token: token })
                .send({ domain: 'cloudron.com', provider: 'noop', config: { }, tlsConfig: { provider: 'hello' }})
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);

                    done();
                });
        });

        it('fails without token', function (done) {
            superagent.post(SERVER_URL + '/api/v1/domains')
                .query({ })
                .send(DOMAIN_0)
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);

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

    describe('locked', function () {
        before(function (done) {
            domaindb.update(DOMAIN_0.domain, { locked: true }, done);
        });

        after(function (done) {
            domaindb.update(DOMAIN_0.domain, { locked: false }, done);
        });

        it('can list the domains', function (done) {
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

        it('cannot get locked domain', function (done) {
            superagent.get(SERVER_URL + '/api/v1/domains/' + DOMAIN_0.domain)
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(423);
                    done();
                });
        });

        it('cannot delete locked domain', function (done) {
            superagent.delete(SERVER_URL + '/api/v1/domains/' + DOMAIN_0.domain)
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(423);
                    done();
                });
        });
    });

    describe('delete', function () {
        it('fails for non-existing domain', function (done) {
            superagent.delete(SERVER_URL + '/api/v1/domains/' + DOMAIN_0.domain + DOMAIN_0.domain)
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(404);

                    done();
                });
        });

        it('succeeds', function (done) {
            superagent.delete(SERVER_URL + '/api/v1/domains/' + DOMAIN_0.domain)
                .query({ access_token: token })
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

    describe('Certificates API', function () {
        var validCert0, validKey0, // example.com
            validCert1, validKey1; // *.example.com

        before(function (done) {
            child_process.execSync(`openssl req -subj "/CN=${DOMAIN_0.domain}/O=My Company Name LTD./C=US" -new -newkey rsa:2048 -days 365 -nodes -x509 -keyout /tmp/server.key -out /tmp/server.crt`);
            validKey0 = fs.readFileSync('/tmp/server.key', 'utf8');
            validCert0 = fs.readFileSync('/tmp/server.crt', 'utf8');

            child_process.execSync(`openssl req -subj "/CN=*.${DOMAIN_0.domain}/O=My Company Name LTD./C=US" -new -newkey rsa:2048 -days 365 -nodes -x509 -keyout /tmp/server.key -out /tmp/server.crt`);
            validKey1 = fs.readFileSync('/tmp/server.key', 'utf8');
            validCert1 = fs.readFileSync('/tmp/server.crt', 'utf8');

            superagent.post(SERVER_URL + '/api/v1/domains')
                .query({ access_token: token })
                .send(DOMAIN_0)
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(201);

                    done();
                });
        });

        it('cannot set certificate without certificate', function (done) {
            var d = _.extend({}, DOMAIN_0);
            d.fallbackCertificate = { key: validKey1 };

            superagent.put(`${SERVER_URL}/api/v1/domains/${DOMAIN_0.domain}`)
                .query({ access_token: token })
                .send(d)
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot set certificate without key', function (done) {
            var d = _.extend({}, DOMAIN_0);
            d.fallbackCertificate = { cert: validCert1 };

            superagent.put(`${SERVER_URL}/api/v1/domains/${DOMAIN_0.domain}`)
                .query({ access_token: token })
                .send(d)
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot set certificate with cert not being a string', function (done) {
            var d = _.extend({}, DOMAIN_0);
            d.fallbackCertificate = { cert: 1234, key: validKey1 };

            superagent.put(`${SERVER_URL}/api/v1/domains/${DOMAIN_0.domain}`)
                .query({ access_token: token })
                .send(d)
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot set certificate with key not being a string', function (done) {
            var d = _.extend({}, DOMAIN_0);
            d.fallbackCertificate = { cert: validCert1, key: true };

            superagent.put(`${SERVER_URL}/api/v1/domains/${DOMAIN_0.domain}`)
                .query({ access_token: token })
                .send(d)
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot set non-fallback certificate', function (done) {
            var d = _.extend({}, DOMAIN_0);
            d.fallbackCertificate = { cert: validCert0, key: validKey0 };

            superagent.put(`${SERVER_URL}/api/v1/domains/${DOMAIN_0.domain}`)
                .query({ access_token: token })
                .send(d)
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('can set fallback certificate', function (done) {
            var d = _.extend({}, DOMAIN_0);
            d.fallbackCertificate = { cert: validCert1, key: validKey1 };

            superagent.put(`${SERVER_URL}/api/v1/domains/${DOMAIN_0.domain}`)
                .query({ access_token: token })
                .send(d)
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(204);
                    done();
                });
        });

        it('did set the certificate', function (done) {
            var cert = fs.readFileSync(path.join(paths.APP_CERTS_DIR, `${DOMAIN_0.domain}.host.cert`), 'utf-8');
            expect(cert).to.eql(validCert1);

            var key = fs.readFileSync(path.join(paths.APP_CERTS_DIR, `${DOMAIN_0.domain}.host.key`), 'utf-8');
            expect(key).to.eql(validKey1);

            done();
        });
    });
});
