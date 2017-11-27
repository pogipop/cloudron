/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var ssh = require('../../ssh.js'),
    async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    nock = require('nock');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';

var INVALID_KEY_TYPE = 'ssh-foobar AAAAB3NzaC1yc2EAAAADAQABAAABAQCibC8G04mZy3o3AVMxjUMQoEQj0HSsl6AMVZDQK9A0e8qVRWft4HaRZdw0dW3iFDsEdny7s1zSAc5Kp5y38kJdSyEHGKxvcR8TaghUa8jpmu0sEVOTn+X4UtoonkNuJ0Jnl2tjPYsq5BtJmAeYUa1bKH5CjomCYi5OSfXRtnuZV6SiYX0A1OnZPXFWa/iFwwOUJQvDLGbFkgtJxqhxpc7yvzwFK5B9MNs7LJxA8+kRibJ9LTN1OKWNxb0oSk/PE6PFo9M2Q/SL9uj2IRXRipGj2XcOtZlqcAK5i+aq3UjjAGekztK2srQPcBkWbnI3Oim2N8l2purCfe0AoCCQHK7N nebulon@nebulon';
var INVALID_KEY_VALUE = 'ssh-rsa foobar nebulon@nebulon';
var INVALID_KEY_IDENTIFIER = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCibC8G04mZy3o3AVMxjUMQoEQj0HSsl6AMVZDQK9A0e8qVRWft4HaRZdw0dW3iFDsEdny7s1zSAc5Kp5y38kJdSyEHGKxvcR8TaghUa8jpmu0sEVOTn+X4UtoonkNuJ0Jnl2tjPYsq5BtJmAeYUa1bKH5CjomCYi5OSfXRtnuZV6SiYX0A1OnZPXFWa/iFwwOUJQvDLGbFkgtJxqhxpc7yvzwFK5B9MNs7LJxA8+kRibJ9LTN1OKWNxb0oSk/PE6PFo9M2Q/SL9uj2IRXRipGj2XcOtZlqcAK5i+aq3UjjAGekztK2srQPcBkWbnI3Oim2N8l2purCfe0AoCCQHK7N';
var VALID_KEY = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCibC8G04mZy3o3AVMxjUMQoEQj0HSsl6AMVZDQK9A0e8qVRWft4HaRZdw0dW3iFDsEdny7s1zSAc5Kp5y38kJdSyEHGKxvcR8TaghUa8jpmu0sEVOTn+X4UtoonkNuJ0Jnl2tjPYsq5BtJmAeYUa1bKH5CjomCYi5OSfXRtnuZV6SiYX0A1OnZPXFWa/iFwwOUJQvDLGbFkgtJxqhxpc7yvzwFK5B9MNs7LJxA8+kRibJ9LTN1OKWNxb0oSk/PE6PFo9M2Q/SL9uj2IRXRipGj2XcOtZlqcAK5i+aq3UjjAGekztK2srQPcBkWbnI3Oim2N8l2purCfe0AoCCQHK7N nebulon@nebulon';
var VALID_KEY_1 = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCibC8G04mZy3o3AVMxjUMQoEQj0HSsl6AMVZDQK9A0e8qVRWft4HaRZdw0dW3iFDsEdny7s1zSAc5Kp5y38kJdSyEHGKxvcR8TaghUa8jpmu0sEVOTn+X4UtoonkNuJ0Jnl2tjPYsq5BtJmAeYUa1bKH5CjomCYi5OSfXRtnuZV6SiYX0A1OnZPXFWa/iFwwOUJQvDLGbFkgtJxqhxpc7yvzwFK5B9MNs7LJxA8+kRibJ9LTN1OKWNxb0oSk/PE6PFo9M2Q/SL9uj2IRXRipGj2XcOtZlqcAK5i+aq3UjjAGekztK2srQPcBkWbnI3Oim2N8l2purCfe0AoCCQHK7N muchmore';

var token = null;

var server;
function setup(done) {
    config._reset();
    config.setFqdn('example-ssh-test.com');

    async.series([
        server.start.bind(server),

        ssh._clear,
        database._clear,

        function createAdmin(callback) {
            var scope1 = nock(config.apiServerOrigin()).get('/api/v1/boxes/' + config.fqdn() + '/setup/verify?setupToken=somesetuptoken').reply(200, {});
            var scope2 = nock(config.apiServerOrigin()).post('/api/v1/boxes/' + config.fqdn() + '/setup/done?setupToken=somesetuptoken').reply(201, {});

            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                   .query({ setupToken: 'somesetuptoken' })
                   .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                   .end(function (error, result) {
                expect(result).to.be.ok();
                expect(result.statusCode).to.eql(201);
                expect(scope1.isDone()).to.be.ok();
                expect(scope2.isDone()).to.be.ok();

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

describe('SSH API', function () {
    this.timeout(10000);

    before(setup);
    after(cleanup);

    describe('add authorized_keys', function () {
        it('fails due to missing key', function (done) {
            superagent.put(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys')
                   .query({ access_token: token })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('fails due to empty key', function (done) {
            superagent.put(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys')
                   .query({ access_token: token })
                   .send({ key: '' })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('fails due to invalid key', function (done) {
            superagent.put(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys')
                   .query({ access_token: token })
                   .send({ key: 'foobar' })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('fails due to invalid key type', function (done) {
            superagent.put(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys')
                   .query({ access_token: token })
                   .send({ key: INVALID_KEY_TYPE })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('fails due to invalid key value', function (done) {
            superagent.put(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys')
                   .query({ access_token: token })
                   .send({ key: INVALID_KEY_VALUE })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('fails due to invalid key identifier', function (done) {
            superagent.put(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys')
                   .query({ access_token: token })
                   .send({ key: INVALID_KEY_IDENTIFIER })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
        });

        it('succeeds', function (done) {
            superagent.put(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys')
                   .query({ access_token: token })
                   .send({ key: VALID_KEY })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(201);
                done();
            });
        });
    });

    describe('get authorized_keys', function () {
        it('fails for non existing key', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys/foobar')
                   .query({ access_token: token })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(404);
                done();
            });
        });

        it('succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys/' + VALID_KEY.split(' ')[2])
                   .query({ access_token: token })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body).to.be.an('object');
                expect(res.body.identifier).to.be.a('string');
                expect(res.body.identifier).to.equal(VALID_KEY.split(' ')[2]);
                expect(res.body.key).to.equal(VALID_KEY);
                done();
            });
        });
    });

    describe('list authorized_keys', function () {
        it('succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys')
                   .query({ access_token: token })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body).to.be.an('object');
                expect(res.body.keys).to.be.an('array');
                expect(res.body.keys.length).to.equal(1);
                expect(res.body.keys[0]).to.be.an('object');
                expect(res.body.keys[0].identifier).to.be.a('string');
                expect(res.body.keys[0].identifier).to.equal(VALID_KEY.split(' ')[2]);
                expect(res.body.keys[0].key).to.equal(VALID_KEY);
                done();
            });
        });

        it('succeeds with two keys', function (done) {
            superagent.put(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys')
                   .query({ access_token: token })
                   .send({ key: VALID_KEY_1 })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(201);

                superagent.get(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys')
                       .query({ access_token: token })
                       .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body).to.be.an('object');
                    expect(res.body.keys).to.be.an('array');
                    expect(res.body.keys.length).to.equal(2);
                    expect(res.body.keys[0]).to.be.an('object');
                    expect(res.body.keys[0].identifier).to.be.a('string');
                    expect(res.body.keys[0].identifier).to.equal(VALID_KEY_1.split(' ')[2]);
                    expect(res.body.keys[0].key).to.equal(VALID_KEY_1);
                    expect(res.body.keys[1]).to.be.an('object');
                    expect(res.body.keys[1].identifier).to.be.a('string');
                    expect(res.body.keys[1].identifier).to.equal(VALID_KEY.split(' ')[2]);
                    expect(res.body.keys[1].key).to.equal(VALID_KEY);
                    done();
                });
            });
        });
    });

    describe('delete authorized_keys', function () {
        it('fails for non existing key', function (done) {
            superagent.del(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys/foobar')
                   .query({ access_token: token })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(404);
                done();
            });
        });

        it('succeeds', function (done) {
            superagent.del(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys/' + VALID_KEY.split(' ')[2])
                   .query({ access_token: token })
                   .end(function (err, res) {
                expect(res.statusCode).to.equal(202);

                superagent.get(SERVER_URL + '/api/v1/cloudron/ssh/authorized_keys/' + VALID_KEY.split(' ')[2])
                       .query({ access_token: token })
                       .end(function (err, res) {
                    expect(res.statusCode).to.equal(404);
                    done();
                });
            });
        });
    });
});
