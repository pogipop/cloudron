/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    tokendb = require('../../tokendb.js');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;

var USER_1_ID = null, token_1;

function setup(done) {
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
        },

        function (callback) {
            superagent.post(SERVER_URL + '/api/v1/users')
                   .query({ access_token: token })
                   .send({ username: 'nonadmin', email: 'notadmin@server.test', invite: false })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(201);

                USER_1_ID = res.body.id;

                callback(null);
            });
        },

        function (callback) {
            token_1 = tokendb.generateToken();

            // HACK to get a token for second user (passwords are generated and the user should have gotten a password setup link...)
            tokendb.add(token_1, USER_1_ID, 'test-client-id',  Date.now() + 100000, '*', callback);
        }

    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(!error).to.be.ok();

        server.stop(done);
    });
}

describe('Eventlog API', function () {
    before(setup);
    after(cleanup);

    describe('get', function () {
        it('fails due to wrong token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog')
                   .query({ access_token: token.toUpperCase() })
                   .end(function (error, result) {
                expect(result.statusCode).to.equal(401);
                done();
            });
        });

        it('fails for non-admin', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog')
                   .query({ access_token: token_1, page: 1, per_page: 10 })
                   .end(function (error, result) {
                expect(result.statusCode).to.equal(403);

                done();
            });
        });

        it('succeeds for admin', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog')
                   .query({ access_token: token, page: 1, per_page: 10 })
                   .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                expect(result.body.eventlogs.length >= 2).to.be.ok(); // activate, user.add

                done();
            });
        });

        it('succeeds with action', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog')
                   .query({ access_token: token, page: 1, per_page: 10, action: 'cloudron.activate' })
                   .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                expect(result.body.eventlogs.length).to.equal(1);

                done();
            });
        });

        it('succeeds with search', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog')
                   .query({ access_token: token, page: 1, per_page: 10, search: EMAIL })
                   .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                expect(result.body.eventlogs.length).to.equal(1);

                done();
            });
        });

        it('succeeds with search', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog')
                   .query({ access_token: token, page: 1, per_page: 10, search: EMAIL, action: 'cloudron.activate' })
                   .end(function (error, result) {
                expect(result.statusCode).to.equal(200);
                expect(result.body.eventlogs.length).to.equal(0);

                done();
            });
        });
    });
});
