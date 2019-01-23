/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var accesscontrol = require('../../accesscontrol.js'),
    async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    eventlogdb = require('../../eventlogdb.js'),
    expect = require('expect.js'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    tokendb = require('../../tokendb.js');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;

var USER_1_ID = null, token_1;

var EVENT_0 = {
    id: 'event_0',
    action: 'foobaraction',
    source: {
        ip: '127.0.0.1'
    },
    data: {
        something: 'is there'
    }
};

function setup(done) {
    config._reset();
    config.setFqdn('example-eventlog-test.com');

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
            tokendb.add(token_1, USER_1_ID, 'test-client-id',  Date.now() + 100000, accesscontrol.SCOPE_PROFILE, '', callback);
        },

        function (callback) {
            eventlogdb.add(EVENT_0.id, EVENT_0.action, EVENT_0.source, EVENT_0.data, callback);
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
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog/' + EVENT_0.id)
                .query({ access_token: token.toUpperCase() })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);

                    done();
                });
        });

        it('fails for non-admin', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog/' + EVENT_0.id)
                .query({ access_token: token_1 })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(403);

                    done();
                });
        });

        it('fails if not exists', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog/doesnotexist')
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(404);

                    done();
                });
        });

        it('succeeds for admin', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog/' + EVENT_0.id)
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(result.body.event).to.be.an('object');
                    expect(result.body.event.creationTime).to.be.a('string');

                    delete result.body.event.creationTime;
                    expect(result.body.event).to.eql(EVENT_0);

                    done();
                });
        });
    });

    describe('list', function () {
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

        it('succeeds with deprecated action', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog')
                .query({ access_token: token, page: 1, per_page: 10, action: 'cloudron.activate' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(result.body.eventlogs.length).to.equal(1);

                    done();
                });
        });

        it('succeeds with actions', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog')
                .query({ access_token: token, page: 1, per_page: 10, actions: 'cloudron.activate, user.add' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(result.body.eventlogs.length).to.equal(3);

                    done();
                });
        });

        it('succeeds with search', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog')
                .query({ access_token: token, page: 1, per_page: 10, search: EMAIL })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(result.body.eventlogs.length).to.equal(2);

                    done();
                });
        });

        it('succeeds with search', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/eventlog')
                .query({ access_token: token, page: 1, per_page: 10, search: EMAIL, actions: 'cloudron.activate' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(result.body.eventlogs.length).to.equal(0);

                    done();
                });
        });
    });
});
