/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var accesscontrol = require('../../accesscontrol.js'),
    async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    domains = require('../../domains.js'),
    tokendb = require('../../tokendb.js'),
    expect = require('expect.js'),
    groups = require('../../groups.js'),
    mail = require('../../mail.js'),
    mailer = require('../../mailer.js'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    users = require('../../users.js');

const SERVER_URL = 'http://localhost:' + config.get('port');

const DOMAIN_0 = {
    domain: 'example-user-test.com',
    zoneName: 'example-user-test.com',
    config: {},
    provider: 'noop',
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

let AUDIT_SOURCE = { ip: '1.2.3.4' };

const USERNAME_0 = 'superaDmIn', PASSWORD = 'Foobar?1337', EMAIL_0 = 'silLY@me.com', EMAIL_0_NEW = 'stupID@me.com', DISPLAY_NAME_0_NEW = 'New Name';
const USERNAME_1 = 'userTheFirst', EMAIL_1 = 'taO@zen.mac';
const USERNAME_2 = 'userTheSecond', EMAIL_2 = 'USER@foo.bar', EMAIL_2_NEW = 'happy@ME.com';
const USERNAME_3 = 'ut', EMAIL_3 = 'user3@FOO.bar';
const USERNAME_4 = 'importedUser', EMAIL_4 = 'import@external.com';

var groupObject;

function setup(done) {
    config._reset();

    async.series([
        server.start,
        database._clear,
        mailer._clearMailQueue,
        domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE),
        mail.addDomain.bind(null, DOMAIN_0.domain)
    ], function (error) {
        expect(error).to.not.be.ok();

        groups.create('somegroupname', function (error, result) {
            expect(error).to.not.be.ok();

            groupObject = result;

            done();
        });
    });
}

function cleanup(done) {
    database._clear(function (error) {
        expect(!error).to.be.ok();

        mailer._clearMailQueue();

        server.stop(done);
    });
}

function checkMails(number, done) {
    // mails are enqueued async
    setTimeout(function () {
        expect(mailer._getMailQueue().length).to.equal(number);
        mailer._clearMailQueue();
        done();
    }, 500);
}

describe('Users API', function () {
    this.timeout(5000);

    var user_0, user_1, user_2, user_4;
    var token = null, userToken = null;
    var token_1 = tokendb.generateToken();

    before(setup);
    after(cleanup);

    it('device is in first time mode', function (done) {
        superagent.get(SERVER_URL + '/api/v1/cloudron/status')
            .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.activated).to.not.be.ok();
                done(err);
            });
    });

    it('create admin fails due to missing parameters', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
            .query({ setupToken: 'somesetuptoken' })
            .send({ username: USERNAME_0 })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
    });

    it('create admin fails because only POST is allowed', function (done) {
        superagent.get(SERVER_URL + '/api/v1/cloudron/activate')
            .end(function (err, res) {
                expect(res.statusCode).to.equal(404);
                done();
            });
    });

    it('create admin', function (done) {
        superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
            .query({ setupToken: 'somesetuptoken' })
            .send({ username: USERNAME_0, password: PASSWORD, email: EMAIL_0 })
            .end(function (err, res) {
                expect(err).to.eql(null);
                expect(res.statusCode).to.equal(201);

                // stash for later use
                token = res.body.token;

                superagent.get(SERVER_URL + '/api/v1/profile').query({ access_token: token }).end(function (error, result) {
                    expect(error).to.eql(null);
                    expect(result.status).to.equal(200);

                    // stash for further use
                    user_0 = result.body;

                    done();
                });
            });
    });

    it('device left first time mode', function (done) {
        superagent.get(SERVER_URL + '/api/v1/cloudron/status')
            .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.activated).to.be.ok();
                done();
            });
    });

    it('cannot get userInfo by username', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users/' + USERNAME_0)
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(404);

                done();
            });
    });

    it('can get userInfo with token', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users/' + user_0.id)
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.username).to.equal(USERNAME_0.toLowerCase());
                expect(res.body.email).to.equal(EMAIL_0.toLowerCase());
                expect(res.body.groupIds).to.eql([]);
                expect(res.body.admin).to.be(true);

                done();
            });
    });

    it('cannot get userInfo with expired token', function (done) {
        var token = tokendb.generateToken();
        var expires = Date.now() + 2000; // 1 sec

        tokendb.add(token, user_0.id, null, expires, accesscontrol.SCOPE_PROFILE, 'tokenname', function (error) {
            expect(error).to.not.be.ok();

            setTimeout(function () {
                superagent.get(SERVER_URL + '/api/v1/users/' + user_0.username)
                    .query({ access_token: token })
                    .end(function (error, result) {
                        expect(result.statusCode).to.equal(401);
                        done();
                    });
            }, 2000);
        });
    });

    it('can get userInfo with token', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users/' + user_0.id)
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.username).to.equal(USERNAME_0.toLowerCase());
                expect(res.body.email).to.equal(EMAIL_0.toLowerCase());
                expect(res.body.groupIds).to.eql([]);
                expect(res.body.admin).to.be(true);

                done();
            });
    });

    it('cannot get userInfo only with basic auth', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users/' + user_0.id)
            .auth(USERNAME_0, PASSWORD)
            .end(function (err, res) {
                expect(res.statusCode).to.equal(401);
                done();
            });
    });

    it('cannot get userInfo with invalid token (token length)', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users/' + user_0.id)
            .query({ access_token: 'x' + token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(401);
                done();
            });
    });

    it('cannot get userInfo with invalid token (wrong token)', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users/' + user_0.id)
            .query({ access_token: token.toUpperCase() })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(401);
                done();
            });
    });

    it('can get userInfo with token in auth header', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users/' + user_0.id)
            .set('Authorization', 'Bearer ' + token)
            .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.username).to.equal(USERNAME_0.toLowerCase());
                expect(res.body.email).to.equal(EMAIL_0.toLowerCase());
                expect(res.body.groupIds).to.eql([]);
                expect(res.body.admin).to.be(true);
                expect(res.body.displayName).to.be.a('string');
                expect(res.body.password).to.not.be.ok();
                expect(res.body.salt).to.not.be.ok();
                done();
            });
    });

    it('cannot get userInfo with invalid token in auth header', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users/' + user_0.id)
            .set('Authorization', 'Bearer ' + 'x' + token)
            .end(function (err, res) {
                expect(res.statusCode).to.equal(401);
                done();
            });
    });

    it('cannot get userInfo with invalid token (wrong token)', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users/' + user_0.id)
            .set('Authorization', 'Bearer ' + 'x' + token.toUpperCase())
            .end(function (err, res) {
                expect(res.statusCode).to.equal(401);
                done();
            });
    });

    it('cannot create user without email', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .send({ username: USERNAME_1 })
            .end(function (error, result) {
                expect(error).to.be.ok();
                expect(result.statusCode).to.equal(400);
                done();
            });
    });

    it('create second user succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .send({ username: USERNAME_1, email: EMAIL_1 })
            .end(function (error, result) {
                expect(error).to.not.be.ok();
                expect(result.statusCode).to.equal(201);

                user_1 = result.body;

                // HACK to get a token for second user (passwords are generated and the user should have gotten a password setup link...)
                tokendb.add(token_1, user_1.id, 'test-client-id',  Date.now() + 10000, accesscontrol.SCOPE_PROFILE, 'fromtest', done);
            });
    });

    it('reinvite unknown user fails', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + USERNAME_1+USERNAME_1 + '/create_invite')
            .query({ access_token: token })
            .send({})
            .end(function (err, res) {
                expect(err).to.be.an(Error);
                expect(res.statusCode).to.equal(404);
                done();
            });
    });

    it('send invite without creating invite fails succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_1.id + '/send_invite')
            .query({ access_token: token })
            .send({})
            .end(function (err, res) {
                expect(err).to.be.an(Error);
                expect(res.statusCode).to.equal(409);
                done();
            });
    });

    it('create invite second user succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_1.id + '/create_invite')
            .query({ access_token: token })
            .send({})
            .end(function (err, res) {
                expect(err).to.not.be.ok();
                expect(res.statusCode).to.equal(200);
                expect(res.body.resetToken).to.be.ok();
                done();
            });
    });

    it('can send invite', function (done) {
        mailer._clearMailQueue();

        superagent.post(SERVER_URL + '/api/v1/users/' + user_1.id + '/send_invite')
            .query({ access_token: token })
            .send({})
            .end(function (err, res) {
                expect(err).to.be(null);
                expect(res.statusCode).to.equal(200);
                checkMails(1, done);
            });
    });

    it('set second user as admin succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_1.id)
            .query({ access_token: token })
            .send({ admin: true })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(204);

                superagent.get(SERVER_URL + '/api/v1/users/' + user_1.id)
                    .query({ access_token: token })
                    .end(function (err, res) {
                        expect(res.statusCode).to.equal(200);
                        expect(res.body.admin).to.be(true);

                        done();
                    });
            });
    });

    it('does not list groupIds when listing users', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .end(function (error, res) {
                expect(error).to.be(null);
                expect(res.statusCode).to.equal(200);
                expect(res.body.users).to.be.an('array');

                res.body.users.forEach(function (user) {
                    expect('groupIds' in user).to.be(false);
                });
                done();
            });
    });

    it('remove self as admin fails', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_0.id)
            .query({ access_token: token })
            .send({ admin: false })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(409);
                done();
            });
    });

    it('remove second user from admins succeeds', function (done) {
        superagent.put(SERVER_URL + '/api/v1/users/' + user_1.id + '/groups')
            .query({ access_token: token })
            .send({ groupIds: [ groupObject.id ] })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(204);

                superagent.get(SERVER_URL + '/api/v1/users/' + user_1.id)
                    .query({ access_token: token })
                    .end(function (err, res) {
                        expect(res.statusCode).to.equal(200);
                        expect(res.body.groupIds).to.eql([ groupObject.id ]);

                        done();
                    });
            });
    });

    it('create user missing username succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .send({ email: `unnamed${EMAIL_2}` })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(201);
                done();
            });
    });

    it('create user missing email fails', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .send({ username: USERNAME_2 })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(400);
                done();
            });
    });

    it('create user reserved name fails', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .send({ username: 'no-reply' })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(400);
                done();
            });
    });

    it('create user with short name fails', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .send({ username: 'n' })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(400);
                done();
            });
    });

    it('create second and third user', function (done) {
        mailer._clearMailQueue();
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .send({ username: USERNAME_2, email: EMAIL_2 })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(201);

                user_2 = result.body;

                superagent.post(SERVER_URL + '/api/v1/users')
                    .query({ access_token: token })
                    .send({ username: USERNAME_3, email: EMAIL_3 })
                    .end(function (error, result) {
                        expect(result.statusCode).to.equal(201);

                        // two mails for user creation
                        checkMails(2, done);
                    });
            });
    });

    it('get userInfo succeeds for second user', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users/' + user_2.id)
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                expect(result.body.username).to.equal(USERNAME_2.toLowerCase());
                expect(result.body.email).to.equal(EMAIL_2.toLowerCase());
                expect(result.body.groupIds).to.eql([]);

                done();
            });
    });

    it('create user with same username should fail', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .send({ username: USERNAME_2, email: EMAIL_0, invite: false })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(409);
                done();
            });
    });

    it('list users fails for normal user', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users')
            .query({ access_token: token_1 })
            .end(function (error, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
    });

    it('list users succeeds for admin', function (done) {
        superagent.get(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .end(function (error, res) {
                expect(error).to.be(null);
                expect(res.statusCode).to.equal(200);
                expect(res.body.users).to.be.an('array');
                expect(res.body.users.length).to.equal(5);

                res.body.users.forEach(function (user) {
                    expect(user).to.be.an('object');
                    expect(user.id).to.be.ok();
                    expect(user.email).to.be.ok();
                    if (!user.email.startsWith('unnamed')) expect(user.username).to.be.ok();
                    expect(user.password).to.not.be.ok();
                    expect(user.salt).to.not.be.ok();
                    expect(user.groupIds).to.not.be.ok();
                });

                done();
            });
    });

    it('remove random user fails', function (done) {
        superagent.del(SERVER_URL + '/api/v1/users/randomid')
            .query({ access_token: token })
            .send({ password: PASSWORD })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(404);
                done();
            });
    });

    it('user removes himself is not allowed', function (done) {
        superagent.del(SERVER_URL + '/api/v1/users/' + user_0.id)
            .query({ access_token: token })
            .send({ password: PASSWORD })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(409);
                done();
            });
    });

    it('admin cannot remove normal user without giving a password', function (done) {
        superagent.del(SERVER_URL + '/api/v1/users/' + user_1.id)
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
    });

    it('admin cannot remove normal user with empty password', function (done) {
        superagent.del(SERVER_URL + '/api/v1/users/' + user_1.id)
            .query({ access_token: token })
            .send({ password: '' })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
    });

    it('admin cannot remove normal user with giving wrong password', function (done) {
        superagent.del(SERVER_URL + '/api/v1/users/' + user_1.id)
            .query({ access_token: token })
            .send({ password: PASSWORD + PASSWORD })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
    });

    it('admin removes normal user', function (done) {
        superagent.del(SERVER_URL + '/api/v1/users/' + user_1.id)
            .query({ access_token: token })
            .send({ password: PASSWORD })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(204);
                done();
            });
    });

    it('admin removes himself should not be allowed', function (done) {
        superagent.del(SERVER_URL + '/api/v1/users/' + user_0.id)
            .query({ access_token: token })
            .send({ password: PASSWORD })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(409);
                done();
            });
    });

    // Change email
    it('change email fails due to missing token', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_0.id)
            .send({ email: EMAIL_0_NEW })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
    });

    it('change email fails due to invalid email', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_0.id)
            .query({ access_token: token })
            .send({ email: 'foo@bar' })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(400);
                done();
            });
    });

    it('change user succeeds without email nor displayName', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_0.id)
            .query({ access_token: token })
            .send({})
            .end(function (error, result) {
                expect(result.statusCode).to.equal(204);
                done();
            });
    });

    it('change email succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_2.id)
            .query({ access_token: token })
            .send({ email: EMAIL_2_NEW })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(204);

                superagent.get(SERVER_URL + '/api/v1/users/' + user_2.id)
                    .query({ access_token: token })
                    .end(function (err, res) {
                        expect(res.statusCode).to.equal(200);
                        expect(res.body.username).to.equal(USERNAME_2.toLowerCase());
                        expect(res.body.email).to.equal(EMAIL_2_NEW.toLowerCase());
                        expect(res.body.displayName).to.equal('');

                        done();
                    });
            });
    });

    it('change email as admin for other user succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_2.id)
            .query({ access_token: token })
            .send({ email: EMAIL_2 })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(204);

                superagent.get(SERVER_URL + '/api/v1/users/' + user_2.id)
                    .query({ access_token: token })
                    .end(function (err, res) {
                        expect(res.statusCode).to.equal(200);
                        expect(res.body.username).to.equal(USERNAME_2.toLowerCase());
                        expect(res.body.email).to.equal(EMAIL_2.toLowerCase());
                        expect(res.body.displayName).to.equal('');

                        done();
                    });
            });
    });

    it('change displayName succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_0.id)
            .query({ access_token: token })
            .send({ displayName: DISPLAY_NAME_0_NEW })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(204);

                superagent.get(SERVER_URL + '/api/v1/users/' + user_0.id)
                    .query({ access_token: token })
                    .end(function (err, res) {
                        expect(res.statusCode).to.equal(200);
                        expect(res.body.username).to.equal(USERNAME_0.toLowerCase());
                        expect(res.body.email).to.equal(EMAIL_0.toLowerCase());
                        expect(res.body.displayName).to.equal(DISPLAY_NAME_0_NEW);

                        done();
                    });
            });
    });

    it('cannot create user with bad password', function (done) {
        mailer._clearMailQueue();

        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .send({ username: USERNAME_4, email: EMAIL_4, password: 'tooweak' })
            .end(function (error, result) {
                expect(error).to.be.ok();
                expect(result.statusCode).to.equal(400);
                done();
            });
    });

    it('can create user with a password', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .send({ username: USERNAME_4, email: EMAIL_4, password: 'Secret1#' })
            .end(function (error, result) {
                expect(error).to.not.be.ok();
                expect(result.statusCode).to.equal(201);

                user_4 = result.body;

                userToken = tokendb.generateToken();
                var expires = Date.now() + 2000; // 1 sec

                tokendb.add(userToken, user_4.id, null, expires, accesscontrol.SCOPE_PROFILE, '', done);
            });
    });

    it('can get profile of user with pre-set password', function (done) {
        superagent.get(SERVER_URL + '/api/v1/profile')
            .query({ access_token: userToken })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(200);

                expect(res.body.email).to.be(EMAIL_4);

                done();
            });
    });

    // Change password
    it('change password fails due to missing token', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_0.id + '/password')
            .send({ password: 'youdontsay' })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
    });

    it('change password fails due to small password', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_0.id + '/password')
            .query({ access_token: token })
            .send({ password: 'small' })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(400);
                done();
            });
    });

    it('change password succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users/' + user_0.id + '/password')
            .query({ access_token: token })
            .send({ password: 'bigenough' })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(204);
                done();
            });
    });

    it('did change the user password', function (done) {
        users.verify(user_0.id, 'bigenough', function (error) {
            expect(error).to.be(null);
            done();
        });
    });
});

