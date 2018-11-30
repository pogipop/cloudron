'use strict';

/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

var async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    speakeasy = require('speakeasy'),
    superagent = require('superagent'),
    server = require('../../server.js');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';

function setup(done) {
    config._reset();
    config.setFqdn('example-developer-test.com');

    async.series([
        server.start.bind(server),
        database._clear
    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(error).to.not.be.ok();

        server.stop(done);
    });
}

describe('Developer API', function () {
    describe('login', function () {
        before(function (done) {
            async.series([
                setup,
                function (callback) {
                    superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                        .query({ setupToken: 'somesetuptoken' })
                        .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                        .end(function (error, result) {
                            expect(result).to.be.ok();

                            callback();
                        });
                },
            ], done);
        });

        after(cleanup);

        it('fails without body', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('fails without username', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .send({ password: PASSWORD })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('fails without password', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .send({ username: USERNAME })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('fails with empty username', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .send({ username: '', password: PASSWORD })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('fails with empty password', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .send({ username: USERNAME, password: '' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('fails with unknown username', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .send({ username: USERNAME + USERNAME, password: PASSWORD })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('fails with unknown email', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .send({ username: USERNAME + EMAIL, password: PASSWORD })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('fails with wrong password', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .send({ username: USERNAME, password: PASSWORD.toUpperCase() })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('with username succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .send({ username: USERNAME, password: PASSWORD })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(new Date(result.body.expires).toString()).to.not.be('Invalid Date');
                    expect(result.body.accessToken).to.be.a('string');
                    done();
                });
        });

        it('with uppercase username succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .send({ username: USERNAME.toUpperCase(), password: PASSWORD })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(new Date(result.body.expires).toString()).to.not.be('Invalid Date');
                    expect(result.body.accessToken).to.be.a('string');
                    done();
                });
        });

        it('with email succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .send({ username: EMAIL, password: PASSWORD })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(new Date(result.body.expires).toString()).to.not.be('Invalid Date');
                    expect(result.body.accessToken).to.be.a('string');
                    done();
                });
        });

        it('with uppercase email succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/developer/login')
                .send({ username: EMAIL.toUpperCase(), password: PASSWORD })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(new Date(result.body.expires).toString()).to.not.be('Invalid Date');
                    expect(result.body.accessToken).to.be.a('string');
                    done();
                });
        });
    });

    describe('2fa login', function () {
        var secret, accessToken;

        before(function (done) {
            async.series([
                setup,
                function (callback) {
                    superagent.post(`${SERVER_URL}/api/v1/cloudron/activate`).query({ setupToken: 'somesetuptoken' }).send({ username: USERNAME, password: PASSWORD, email: EMAIL }).end(function (error, result) {
                        callback(error);
                    });
                },
                function (callback) {
                    superagent.post(`${SERVER_URL}/api/v1/developer/login`).send({ username: USERNAME, password: PASSWORD }).end(function (error, result) {
                        accessToken = result.body.accessToken;
                        callback(error);
                    });
                },
                function (callback) {
                    superagent.post(`${SERVER_URL}/api/v1/profile/twofactorauthentication`).query({ access_token: accessToken }).end(function (error, result) {
                        secret = result.body.secret;
                        callback(error);
                    });
                },
                function (callback) {
                    var totpToken = speakeasy.totp({
                        secret: secret,
                        encoding: 'base32'
                    });

                    superagent.post(`${SERVER_URL}/api/v1/profile/twofactorauthentication/enable`).query({ access_token: accessToken }).send({ totpToken: totpToken }).end(function (error, result) {
                        callback(error);
                    });
                }
            ], done);
        });

        after(function (done) {
            async.series([
                function (callback) {
                    superagent.post(`${SERVER_URL}/api/v1/profile/twofactorauthentication/disable`).query({ access_token: accessToken }).send({ password: PASSWORD }).end(function (error, result) {
                        callback(error);
                    });
                },
                cleanup
            ], done);
        });

        it('fails due to missing token', function (done) {
            superagent.post(`${SERVER_URL}/api/v1/developer/login`).send({ username: USERNAME, password: PASSWORD }).end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('fails due to wrong token', function (done) {
            superagent.post(`${SERVER_URL}/api/v1/developer/login`).send({ username: USERNAME, password: PASSWORD }).send({ totpToken: 'wrongtoken' }).end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('succeeds', function (done) {
            var totpToken = speakeasy.totp({
                secret: secret,
                encoding: 'base32'
            });

            superagent.post(`${SERVER_URL}/api/v1/developer/login`).send({ username: USERNAME, password: PASSWORD }).send({ totpToken: totpToken }).end(function (error, result) {
                expect(error).to.be(null);
                expect(result.statusCode).to.equal(200);
                expect(result.body).to.be.an(Object);
                expect(result.body.accessToken).to.be.a('string');
                done();
            });
        });
    });

    describe('sdk tokens are valid without password checks', function () {
        var token_normal, token_sdk;

        before(function (done) {
            async.series([
                setup,
                function (callback) {
                    superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                        .query({ setupToken: 'somesetuptoken' })
                        .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                        .end(function (error, result) {
                            expect(result).to.be.ok();

                            token_normal = result.body.accessToken;

                            superagent.post(SERVER_URL + '/api/v1/developer/login')
                                .send({ username: USERNAME, password: PASSWORD })
                                .end(function (error, result) {
                                    expect(result.statusCode).to.equal(200);
                                    expect(new Date(result.body.expires).toString()).to.not.be('Invalid Date');
                                    expect(result.body.accessToken).to.be.a('string');

                                    token_sdk = result.body.accessToken;

                                    callback();
                                });
                        });
                },
            ], done);
        });

        after(cleanup);

        it('fails with non sdk token', function (done) {
            superagent.post(SERVER_URL + '/api/v1/profile/password').query({ access_token: token_normal }).send({ newPassword: 'Some?$123' }).end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/profile/password').query({ access_token: token_sdk }).send({ newPassword: 'Some?$123' }).end(function (error, result) {
                expect(result.statusCode).to.equal(204);
                done();
            });
        });
    });
});
