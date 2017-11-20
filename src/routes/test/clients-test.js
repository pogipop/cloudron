'use strict';

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

var async = require('async'),
    config = require('../../config.js'),
    clients = require('../../clients.js'),
    database = require('../../database.js'),
    oauth2 = require('../oauth2.js'),
    expect = require('expect.js'),
    uuid = require('uuid'),
    nock = require('nock'),
    hat = require('hat'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    settings = require('../../settings.js');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;

function cleanup(done) {
    database._clear(function (error) {
        expect(error).to.not.be.ok();

        server.stop(done);
    });
}

describe('OAuth Clients API', function () {
    describe('add', function () {
        before(function (done) {
            // we test caas here
            config.set('provider', 'caas');

            async.series([
                server.start.bind(null),
                database._clear.bind(null),

                function (callback) {
                    var scope1 = nock(config.apiServerOrigin()).get('/api/v1/boxes/' + config.fqdn() + '/setup/verify?setupToken=somesetuptoken').reply(200, {});
                    var scope2 = nock(config.apiServerOrigin()).post('/api/v1/boxes/' + config.fqdn() + '/setup/done?setupToken=somesetuptoken').reply(201, {});

                    superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                           .query({ setupToken: 'somesetuptoken' })
                           .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                           .end(function (error, result) {
                        expect(result).to.be.ok();
                        expect(result.statusCode).to.equal(201);
                        expect(scope1.isDone()).to.be.ok();
                        expect(scope2.isDone()).to.be.ok();

                        // stash token for further use
                        token = result.body.token;

                        callback();
                    });
                },
            ], done);
        });

        after(cleanup);

        describe('without developer mode', function () {
            before(function (done) {
                settings.setDeveloperMode(false, done);
            });

            it('fails', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .query({ access_token: token })
                       .send({ appId: 'someApp', redirectURI: 'http://foobar.com', scope: 'profile' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(412);
                    done();
                });
            });
        });

        describe('with developer mode', function () {
            before(function (done) {
                settings.setDeveloperMode(true, done);
            });

            it('fails without token', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .send({ appId: 'someApp', redirectURI: 'http://foobar.com', scope: 'profile' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
            });

            it('fails without appId', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .query({ access_token: token })
                       .send({ redirectURI: 'http://foobar.com', scope: 'profile' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
            });

            it('fails with empty appId', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .query({ access_token: token })
                       .send({ appId: '', redirectURI: 'http://foobar.com', scope: 'profile' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
            });

            it('fails without scope', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .query({ access_token: token })
                       .send({ appId: 'someApp', redirectURI: 'http://foobar.com' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
            });

            it('fails with empty scope', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .query({ access_token: token })
                       .send({ appId: 'someApp', redirectURI: 'http://foobar.com', scope: '' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
            });

            it('fails without redirectURI', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .query({ access_token: token })
                       .send({ appId: 'someApp', scope: 'profile' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
            });

            it('fails with empty redirectURI', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .query({ access_token: token })
                       .send({ appId: 'someApp', redirectURI: '', scope: 'profile' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
            });

            it('fails with malformed redirectURI', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .query({ access_token: token })
                       .send({ appId: 'someApp', redirectURI: 'foobar', scope: 'profile' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
            });

            it('fails with invalid name', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .query({ access_token: token })
                       .send({ appId: '$"$%^45asdfasdfadf.adf.', redirectURI: 'http://foobar.com', scope: 'profile' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
            });

            it('succeeds with dash', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .query({ access_token: token })
                       .send({ appId: 'fo-1234-bar', redirectURI: 'http://foobar.com', scope: 'profile' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(201);
                    done();
                });
            });

            it('succeeds', function (done) {
                superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                       .query({ access_token: token })
                       .send({ appId: 'someApp', redirectURI: 'http://foobar.com', scope: 'profile' })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(201);
                    expect(result.body.id).to.be.a('string');
                    expect(result.body.appId).to.be.a('string');
                    expect(result.body.redirectURI).to.be.a('string');
                    expect(result.body.clientSecret).to.be.a('string');
                    expect(result.body.scope).to.be.a('string');
                    expect(result.body.type).to.equal(clients.TYPE_EXTERNAL);

                    done();
                });
            });
        });
    });

    describe('get', function () {
        var CLIENT_0 = {
            id: '',
            appId: 'someAppId-0',
            redirectURI: 'http://some.callback0',
            scope: 'profile'
        };

        before(function (done) {
            async.series([
                server.start.bind(null),
                database._clear.bind(null),

                function (callback) {
                    var scope1 = nock(config.apiServerOrigin()).get('/api/v1/boxes/' + config.fqdn() + '/setup/verify?setupToken=somesetuptoken').reply(200, {});
                    var scope2 = nock(config.apiServerOrigin()).post('/api/v1/boxes/' + config.fqdn() + '/setup/done?setupToken=somesetuptoken').reply(201, {});

                    superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                           .query({ setupToken: 'somesetuptoken' })
                           .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                           .end(function (error, result) {
                        expect(result).to.be.ok();
                        expect(scope1.isDone()).to.be.ok();
                        expect(scope2.isDone()).to.be.ok();

                        // stash token for further use
                        token = result.body.token;

                        callback();
                    });
                },

                settings.setDeveloperMode.bind(null, true),

                function (callback) {
                    superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                           .query({ access_token: token })
                           .send({ appId: CLIENT_0.appId, redirectURI: CLIENT_0.redirectURI, scope: CLIENT_0.scope })
                           .end(function (error, result) {
                        expect(result.statusCode).to.equal(201);

                        CLIENT_0 = result.body;

                        callback();
                    });
                }
            ], done);
        });

        after(cleanup);

        describe('without developer mode', function () {
            before(function (done) {
                settings.setDeveloperMode(false, done);
            });

            it('fails', function (done) {
                superagent.get(SERVER_URL + '/api/v1/oauth/clients/' + CLIENT_0.id)
                       .query({ access_token: token })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(412);
                    done();
                });
            });
        });

        describe('with developer mode', function () {
            before(function (done) {
                settings.setDeveloperMode(true, done);
            });

            it('fails without token', function (done) {
                superagent.get(SERVER_URL + '/api/v1/oauth/clients/' + CLIENT_0.id)
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
            });


            it('fails with unknown id', function (done) {
                superagent.get(SERVER_URL + '/api/v1/oauth/clients/' + CLIENT_0.id.toUpperCase())
                       .query({ access_token: token })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(404);
                    done();
                });
            });

            it('succeeds', function (done) {
                superagent.get(SERVER_URL + '/api/v1/oauth/clients/' + CLIENT_0.id)
                       .query({ access_token: token })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(result.body).to.eql(CLIENT_0);
                    done();
                });
            });
        });
    });

    describe('del', function () {
        var CLIENT_0 = {
            id: '',
            appId: 'someAppId-0',
            redirectURI: 'http://some.callback0',
            scope: 'profile'
        };

        var CLIENT_1 = {
            id: '',
            appId: 'someAppId-1',
            redirectURI: 'http://some.callback1',
            scope: 'profile',
            type: clients.TYPE_OAUTH
        };

        before(function (done) {
            async.series([
                server.start.bind(null),
                database._clear.bind(null),

                function (callback) {
                    var scope1 = nock(config.apiServerOrigin()).get('/api/v1/boxes/' + config.fqdn() + '/setup/verify?setupToken=somesetuptoken').reply(200, {});
                    var scope2 = nock(config.apiServerOrigin()).post('/api/v1/boxes/' + config.fqdn() + '/setup/done?setupToken=somesetuptoken').reply(201, {});

                    superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                           .query({ setupToken: 'somesetuptoken' })
                           .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                           .end(function (error, result) {
                        expect(result).to.be.ok();
                        expect(scope1.isDone()).to.be.ok();
                        expect(scope2.isDone()).to.be.ok();

                        // stash token for further use
                        token = result.body.token;

                        callback();
                    });
                },

                settings.setDeveloperMode.bind(null, true),

                function (callback) {
                    superagent.post(SERVER_URL + '/api/v1/oauth/clients')
                           .query({ access_token: token })
                           .send({ appId: CLIENT_0.appId, redirectURI: CLIENT_0.redirectURI, scope: CLIENT_0.scope })
                           .end(function (error, result) {
                        expect(result.statusCode).to.equal(201);

                        CLIENT_0 = result.body;

                        callback();
                    });
                }
            ], done);
        });

        after(cleanup);

        describe('without developer mode', function () {
            before(function (done) {
                settings.setDeveloperMode(false, done);
            });

            it('fails', function (done) {
                superagent.del(SERVER_URL + '/api/v1/oauth/clients/' + CLIENT_0.id)
                       .query({ access_token: token })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(412);
                    done();
                });
            });
        });

        describe('with developer mode', function () {
            before(function (done) {
                settings.setDeveloperMode(true, done);
            });

            it('fails without token', function (done) {
                superagent.del(SERVER_URL + '/api/v1/oauth/clients/' + CLIENT_0.id)
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
            });


            it('fails with unknown id', function (done) {
                superagent.del(SERVER_URL + '/api/v1/oauth/clients/' + CLIENT_0.id.toUpperCase())
                       .query({ access_token: token })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(404);
                    done();
                });
            });

            it('succeeds', function (done) {
                superagent.del(SERVER_URL + '/api/v1/oauth/clients/' + CLIENT_0.id)
                       .query({ access_token: token })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(204);

                    superagent.get(SERVER_URL + '/api/v1/oauth/clients/' + CLIENT_0.id)
                           .query({ access_token: token })
                           .end(function (error, result) {
                        expect(result.statusCode).to.equal(404);

                        done();
                   });
                });
            });

            it('fails for cid-webadmin', function (done) {
                superagent.del(SERVER_URL + '/api/v1/oauth/clients/cid-webadmin')
                       .query({ access_token: token })
                       .end(function (error, result) {
                    expect(result.statusCode).to.equal(405);

                    superagent.get(SERVER_URL + '/api/v1/oauth/clients/cid-webadmin')
                           .query({ access_token: token })
                           .end(function (error, result) {
                        expect(result.statusCode).to.equal(200);

                        done();
                   });
                });
            });

            it('fails for addon auth client', function (done) {
                clients.add(CLIENT_1.appId, CLIENT_1.type, CLIENT_1.redirectURI, CLIENT_1.scope, function (error, result) {
                    expect(error).to.equal(null);

                    CLIENT_1.id = result.id;

                    superagent.del(SERVER_URL + '/api/v1/oauth/clients/' + CLIENT_1.id)
                           .query({ access_token: token })
                           .end(function (error, result) {
                        expect(result.statusCode).to.equal(405);

                        superagent.get(SERVER_URL + '/api/v1/oauth/clients/' + CLIENT_1.id)
                               .query({ access_token: token })
                               .end(function (error, result) {
                            expect(result.statusCode).to.equal(200);

                            done();
                       });
                    });
                });
            });
        });
    });
});

describe('Clients', function () {
    var USER_0 = {
        userId: uuid.v4(),
        username: 'someusername',
        password: 'Strong#$%2345',
        email: 'some@email.com',
        admin: true,
        salt: 'somesalt',
        createdAt: (new Date()).toISOString(),
        modifiedAt: (new Date()).toISOString(),
        resetToken: hat(256)
    };

    // make csrf always succeed for testing
    oauth2.csrf = function (req, res, next) {
        req.csrfToken = function () { return hat(256); };
        next();
    };

    function setup(done) {
        async.series([
            server.start.bind(server),
            database._clear.bind(null),
            function (callback) {
                var scope1 = nock(config.apiServerOrigin()).get('/api/v1/boxes/' + config.fqdn() + '/setup/verify?setupToken=somesetuptoken').reply(200, {});
                var scope2 = nock(config.apiServerOrigin()).post('/api/v1/boxes/' + config.fqdn() + '/setup/done?setupToken=somesetuptoken').reply(201, {});

                superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                       .query({ setupToken: 'somesetuptoken' })
                       .send({ username: USER_0.username, password: USER_0.password, email: USER_0.email })
                       .end(function (error, result) {
                    expect(result).to.be.ok();
                    expect(result.statusCode).to.eql(201);
                    expect(scope1.isDone()).to.be.ok();
                    expect(scope2.isDone()).to.be.ok();

                    // stash for further use
                    token = result.body.token;

                    superagent.get(SERVER_URL + '/api/v1/profile')
                            .query({ access_token: token })
                            .end(function (error, result) {
                        expect(result).to.be.ok();
                        expect(result.statusCode).to.eql(200);

                        USER_0.id = result.body.id;

                        callback();
                    });
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

    describe('get', function () {
        before(setup);
        after(cleanup);

        it('fails due to missing token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/oauth/clients')
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('fails due to empty token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/oauth/clients')
            .query({ access_token: '' })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('fails due to wrong token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/oauth/clients')
            .query({ access_token: token.toUpperCase() })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/oauth/clients')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(200);

                expect(result.body.clients.length).to.eql(3);

                done();
            });
        });
    });

    describe('get tokens by client', function () {
        before(setup);
        after(cleanup);

        it('fails due to missing token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/oauth/clients/cid-webadmin/tokens')
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('fails due to empty token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/oauth/clients/cid-webadmin/tokens')
            .query({ access_token: '' })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('fails due to wrong token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/oauth/clients/cid-webadmin/tokens')
            .query({ access_token: token.toUpperCase() })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('fails due to unkown client', function (done) {
            superagent.get(SERVER_URL + '/api/v1/oauth/clients/CID-WEBADMIN/tokens')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(404);
                done();
            });
        });

        it('succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/oauth/clients/cid-webadmin/tokens')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(200);

                expect(result.body.tokens.length).to.eql(1);
                expect(result.body.tokens[0].identifier).to.eql(USER_0.id);

                done();
            });
        });
    });

    describe('delete tokens by client', function () {
        before(setup);
        after(cleanup);

        it('fails due to missing token', function (done) {
            superagent.del(SERVER_URL + '/api/v1/oauth/clients/cid-webadmin/tokens')
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('fails due to empty token', function (done) {
            superagent.del(SERVER_URL + '/api/v1/oauth/clients/cid-webadmin/tokens')
            .query({ access_token: '' })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('fails due to wrong token', function (done) {
            superagent.del(SERVER_URL + '/api/v1/oauth/clients/cid-webadmin/tokens')
            .query({ access_token: token.toUpperCase() })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('fails due to unkown client', function (done) {
            superagent.del(SERVER_URL + '/api/v1/oauth/clients/CID-WEBADMIN/tokens')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(404);
                done();
            });
        });

        it('succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/oauth/clients/cid-webadmin/tokens')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(200);

                expect(result.body.tokens.length).to.eql(1);
                expect(result.body.tokens[0].identifier).to.eql(USER_0.id);

                superagent.del(SERVER_URL + '/api/v1/oauth/clients/cid-webadmin/tokens')
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(204);

                    // further calls with this token should not work
                    superagent.get(SERVER_URL + '/api/v1/profile')
                    .query({ access_token: token })
                    .end(function (error, result) {
                        expect(result.statusCode).to.equal(401);
                        done();
                    });
                });
            });
        });
    });
});
