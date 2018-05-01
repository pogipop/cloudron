'use strict';

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

var accesscontrol = require('../../accesscontrol.js'),
    async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    nock = require('nock'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    settings = require('../../settings.js'),
    settingsdb = require('../../settingsdb.js'),
    tokendb = require('../../tokendb.js');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null; // authentication token
var USERNAME_1 = 'userTheFirst', EMAIL_1 = 'taO@zen.mac', userId_1, token_1;

function setup(done) {
    nock.cleanAll();
    config._reset();
    config.setFqdn('example-cloudron-test.com');
    config.setAdminFqdn('my.example-cloudron-test.com');

    async.series([
        server.start.bind(server),
        database._clear,
        settings.setBackupConfig.bind(null, { provider: 'filesystem', backupFolder: '/tmp', format: 'tgz' }),
        settingsdb.set.bind(null, settings.APPSTORE_CONFIG_KEY, JSON.stringify({ userId: 'USER_ID', cloudronId: 'CLOUDRON_ID', token: 'ACCESS_TOKEN' }))
    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(error).to.not.be.ok();

        config._reset();

        server.stop(done);
    });
}

describe('User test', function () {
    describe('get config', function () {
        before(function (done) {
            async.series([
                setup,

                function (callback) {
                    superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                        .query({ setupToken: 'somesetuptoken' })
                        .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                        .end(function (error, result) {
                            expect(result).to.be.ok();

                            // stash token for further use
                            token = result.body.token;

                            callback();
                        });
                },

                function (callback) {
                    superagent.post(SERVER_URL + '/api/v1/users')
                        .query({ access_token: token })
                        .send({ username: USERNAME_1, email: EMAIL_1, invite: false })
                        .end(function (error, result) {
                            expect(result).to.be.ok();
                            expect(result.statusCode).to.eql(201);

                            token_1 = tokendb.generateToken();
                            userId_1 = result.body.id;

                            // HACK to get a token for second user (passwords are generated and the user should have gotten a password setup link...)
                            tokendb.add(token_1, userId_1, 'test-client-id',  Date.now() + 100000, accesscontrol.SCOPE_ANY, callback);
                        });
                }
            ], done);
        });

        after(cleanup);

        it('cannot get without token', function (done) {
            superagent.get(SERVER_URL + '/api/v1/user/cloudron_config')
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/user/cloudron_config')
                .query({ access_token: token_1 })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);

                    expect(result.body.apiServerOrigin).to.eql('http://localhost:6060');
                    expect(result.body.webServerOrigin).to.eql(null);
                    expect(result.body.adminFqdn).to.eql(config.adminFqdn());
                    expect(result.body.progress).to.be.an('object');
                    expect(result.body.version).to.eql(config.version());
                    expect(result.body.cloudronName).to.be.a('string');
                    expect(result.body.provider).to.be.a('string');

                    expect(result.body.update).to.be(undefined);
                    expect(result.body.size).to.be(undefined);
                    expect(result.body.region).to.be(undefined);
                    expect(result.body.memory).to.be(undefined);

                    done();
                });
        });
    });
});
