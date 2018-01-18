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
    server = require('../../server.js');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;

function setup(done) {
    config._reset();
    config.setFqdn('example-server-test.com');
    config.setVersion('1.2.3');

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

describe('REST API', function () {
    before(setup);
    after(cleanup);

    it('does not crash with invalid JSON', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .set('content-type', 'application/json')
            .send('some invalid non-strict json')
            .end(function (error, result) {
                expect(result.statusCode).to.equal(400);
                expect(result.body.message).to.be('Failed to parse body');

                done();
            });
    });

    it('does not crash with invalid string', function (done) {
        superagent.post(SERVER_URL + '/api/v1/users')
            .query({ access_token: token })
            .set('content-type', 'application/x-www-form-urlencoded')
            .send('some string')
            .end(function (error, result) {
                expect(result.statusCode).to.equal(400);

                done();
            });
    });
});
