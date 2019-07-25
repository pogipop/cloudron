/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var accesscontrol = require('../../accesscontrol.js'),
    async = require('async'),
    config = require('../../config.js'),
    constants = require('../../constants.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    hat = require('../../hat.js'),
    server = require('../../server.js'),
    superagent = require('superagent'),
    tokendb = require('../../tokendb.js');

var SERVER_URL = 'http://localhost:' + constants.PORT;

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var USERNAME_1 = 'user', PASSWORD_1 = 'Foobar?1337', EMAIL_1 ='happy@me.com';
var token, token_1 = null;
var userId, userId_1 = null;

var GROUP_NAME = 'externals';
var groupObject, group1Object;

function setup(done) {
    config._reset();
    config.setFqdn('example-groups-test.com');

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

                    superagent.get(SERVER_URL + '/api/v1/profile')
                        .query({ access_token: token })
                        .end(function (error, result) {
                            expect(result).to.be.ok();
                            expect(result.statusCode).to.eql(200);

                            userId = result.body.id;

                            callback();
                        });
                });
        },
        function (callback) {
            superagent.post(SERVER_URL + '/api/v1/users')
                .query({ access_token: token })
                .send({ username: USERNAME_1, email: EMAIL_1, invite: false })
                .end(function (error, result) {
                    expect(result).to.be.ok();
                    expect(result.statusCode).to.eql(201);

                    token_1 = hat(8 * 32);
                    userId_1 = result.body.id;

                    // HACK to get a token for second user (passwords are generated and the user should have gotten a password setup link...)
                    tokendb.add({ id: 'tid-1', accessToken: token_1, identifier: userId_1, clientId: 'test-client-id', expires: Date.now() + 100000, scope: accesscontrol.SCOPE_PROFILE, name: '' }, callback);
                });
        }
    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(!error).to.be.ok();

        server.stop(done);
    });
}

describe('Groups API', function () {
    before(setup);
    after(cleanup);

    it('create fails due to mising token', function (done) {
        superagent.post(SERVER_URL + '/api/v1/groups')
            .send({ name: GROUP_NAME})
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
    });

    it('create succeeds', function (done) {
        superagent.post(SERVER_URL + '/api/v1/groups')
            .query({ access_token: token })
            .send({ name: GROUP_NAME})
            .end(function (error, result) {
                expect(result.statusCode).to.equal(201);
                groupObject = result.body;
                done();
            });
    });

    it('create fails for already exists', function (done) {
        superagent.post(SERVER_URL + '/api/v1/groups')
            .query({ access_token: token })
            .send({ name: GROUP_NAME})
            .end(function (error, result) {
                expect(result.statusCode).to.equal(409);
                done();
            });
    });

    it('can create another group', function (done) {
        superagent.post(SERVER_URL + '/api/v1/groups')
            .query({ access_token: token })
            .send({ name: 'group1'})
            .end(function (error, result) {
                expect(result.statusCode).to.equal(201);
                group1Object = result.body;
                done();
            });
    })

    it('cannot add user to invalid group', function (done) {
        superagent.put(SERVER_URL + '/api/v1/users/' + userId + '/groups')
            .query({ access_token: token })
            .send({ groupIds: [ groupObject.id, 'something' ]})
            .end(function (error, result) {
                expect(result.statusCode).to.equal(404);
                done();
            });
    });

    it('can set groups of a user', function (done) {
        superagent.put(SERVER_URL + '/api/v1/users/' + userId + '/groups')
            .query({ access_token: token })
            .send({ groupIds: [ groupObject.id, group1Object.id ]})
            .end(function (error, result) {
                expect(result.statusCode).to.equal(204);
                done();
            });
    });

    it('can set users of a group', function (done) {
        superagent.put(SERVER_URL + '/api/v1/groups/' + groupObject.id + '/members')
            .query({ access_token: token })
            .send({ userIds: [ userId, userId_1 ]})
            .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                done();
            });
    });

    it('cannot get non-existing group', function (done) {
        superagent.get(SERVER_URL + '/api/v1/groups/nope')
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(404);
                done();
            });
    });

    it('cannot get existing group with normal user', function (done) {
        superagent.get(SERVER_URL + '/api/v1/groups/' + groupObject.id)
            .query({ access_token: token_1 })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(403);
                done();
            });
    });

    it('can get existing group', function (done) {
        superagent.get(SERVER_URL + '/api/v1/groups/' + groupObject.id)
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                expect(result.body.name).to.be(groupObject.name);
                expect(result.body.userIds.length).to.be(2);
                expect(result.body.userIds[0]).to.be(userId);
                expect(result.body.userIds[1]).to.be(userId_1);
                done();
            });
    });

    it('cannot list groups without token', function (done) {
        superagent.get(SERVER_URL + '/api/v1/groups')
            .end(function (err, res) {
                expect(res.statusCode).to.equal(401);
                done();
            });
    });

    it('cannot list groups as normal user', function (done) {
        superagent.get(SERVER_URL + '/api/v1/groups')
            .query({ access_token: token_1 })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
    });

    it('can list groups', function (done) {
        superagent.get(SERVER_URL + '/api/v1/groups')
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.groups).to.be.an(Array);
                expect(res.body.groups.length).to.be(2);
                expect(res.body.groups[0].name).to.eql(groupObject.name);
                expect(res.body.groups[1].name).to.eql(group1Object.name);
                done();
            });
    });

    it('remove user from group', function (done) {
        superagent.put(SERVER_URL + '/api/v1/users/' + userId + '/groups')
            .query({ access_token: token })
            .send({ groupIds: [ groupObject.id ]})
            .end(function (error, result) {
                expect(result.statusCode).to.equal(204);
                done();
            });
    });

    it('cannot remove without token', function (done) {
        superagent.del(SERVER_URL + '/api/v1/groups/externals')
            .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
    });

    it('can clear users of a group', function (done) {
        superagent.put(SERVER_URL + '/api/v1/groups/' + group1Object.id + '/members')
            .query({ access_token: token })
            .send({ userIds: [ ]})
            .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                done();
            });
    });

    it('can remove empty group', function (done) {
        superagent.del(SERVER_URL + '/api/v1/groups/' + group1Object.id)
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(204);
                done();
            });
    });

    it('can remove non-empty group', function (done) {
        superagent.del(SERVER_URL + '/api/v1/groups/' + groupObject.id)
            .query({ access_token: token })
            .end(function (error, result) {
                expect(result.statusCode).to.equal(204);
                done();
            });
    });
});
