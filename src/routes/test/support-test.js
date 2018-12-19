/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    path = require('path'),
    safe = require('safetydance'),
    superagent = require('superagent'),
    server = require('../../server.js');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var AUTHORIZED_KEYS_FILE = path.join(config.baseDir(), 'authorized_keys');
var token = null;

function setup(done) {
    config._reset();
    config.setFqdn('example-ssh-test.com');
    safe.fs.unlinkSync(AUTHORIZED_KEYS_FILE);

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
        }
    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(!error).to.be.ok();

        server.stop(done);
    });
}

describe('Support API', function () {
    before(setup);
    after(cleanup);

    describe('remote support', function () {
        it('get remote support', function (done) {
            superagent.get(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.enabled).to.be(false);
                    done();
                });
        });

        it('enable remote support', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .send({ enable: true })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);

                    let data = safe.fs.readFileSync(AUTHORIZED_KEYS_FILE, 'utf8');
                    let count = (data.match(/support@cloudron.io/g) || []).length;
                    expect(count).to.be(1);
                    done();
                });
        });

        it('returns true when remote support enabled', function (done) {
            superagent.get(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.enabled).to.be(true);
                    done();
                });
        });

        it('enable remote support (again)', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .send({ enable: true })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);

                    let data = safe.fs.readFileSync(AUTHORIZED_KEYS_FILE, 'utf8');
                    let count = (data.match(/support@cloudron.io/g) || []).length;
                    expect(count).to.be(1);
                    done();
                });
        });

        it('disable remote support', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .send({ enable: false })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);

                    let data = safe.fs.readFileSync(AUTHORIZED_KEYS_FILE, 'utf8');
                    let count = (data.match(/support@cloudron.io/g) || []).length;
                    expect(count).to.be(0);
                    done();
                });
        });

        it('disable remote support (again)', function (done) {
            superagent.post(SERVER_URL + '/api/v1/support/remote_support')
                .query({ access_token: token })
                .send({ enable: false })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);

                    let data = safe.fs.readFileSync(AUTHORIZED_KEYS_FILE, 'utf8');
                    let count = (data.match(/support@cloudron.io/g) || []).length;
                    expect(count).to.be(0);
                    done();
                });
        });
    });
});
