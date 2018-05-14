/* global it:false */
/* global describe:false */
/* global xdescribe:false */
/* global before:false */
/* global after:false */

'use strict';

var appdb = require('../../appdb.js'),
    async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    domains = require('../../domains.js'),
    expect = require('expect.js'),
    locker = require('../../locker.js'),
    nock = require('nock'),
    os = require('os'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    settings = require('../../settings.js'),
    settingsdb = require('../../settingsdb.js'),
    shell = require('../../shell.js');

const SERVER_URL = 'http://localhost:' + config.get('port');
const USERNAME = 'superadmin';
const PASSWORD = 'Foobar?1337';
const EMAIL ='silly@me.com';

const DOMAIN_0 = {
    domain: 'example-backups-test.com',
    zoneName: 'example-backups-test.com',
    config: {},
    provider: 'noop',
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

var token = null, ownerId = null;
var gSudoOriginal = null;
function injectShellMock() {
    gSudoOriginal = shell.sudo;
    shell.sudo = function (tag, options, callback) { callback(null); };
}

function restoreShellMock() {
    shell.sudo = gSudoOriginal;
}

function setup(done) {
    nock.cleanAll();
    config._reset();
    config.set('provider', 'caas');
    config.setVersion('1.2.3');

    async.series([
        server.start.bind(server),

        database._clear,

        settingsdb.set.bind(null, settings.CAAS_CONFIG_KEY, JSON.stringify({ boxId: 'BOX_ID', token: 'ACCESS_TOKEN2' })),
        domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig),

        function createAdmin(callback) {
            var scope1 = nock(config.apiServerOrigin()).get('/api/v1/boxes/BOX_ID/setup/verify?setupToken=somesetuptoken').reply(200, {});
            var scope2 = nock(config.apiServerOrigin()).post('/api/v1/boxes/BOX_ID/setup/done?setupToken=somesetuptoken').reply(201, {});

            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                .end(function (error, result) {
                    expect(result).to.be.ok();
                    expect(result.statusCode).to.eql(201);
                    expect(scope1.isDone()).to.be.ok();
                    expect(scope2.isDone()).to.be.ok();

                    // stash token for further use
                    ownerId = result.body.userId;
                    token = result.body.token;

                    callback();
                });
        },

        function addApp(callback) {
            var manifest = { version: '0.0.1', manifestVersion: 1, dockerImage: 'foo', healthCheckPath: '/', httpPort: 3, title: 'ok', addons: { } };
            appdb.add('appid', 'appStoreId', manifest, 'location', DOMAIN_0.domain, ownerId, [ ] /* portBindings */, { }, callback);
        },

        function createSettings(callback) {
            settings.setBackupConfig({ provider: 'filesystem', backupFolder: '/tmp', format: 'tgz' }, callback);
        }
    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(!error).to.be.ok();

        server.stop(done);
    });
}

describe('Caas', function () {
    describe('activate', function () {
        before(setup);
        after(cleanup);

        it('fails due to missing setupToken', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .send({ username: '', password: 'somepassword', email: 'admin@foo.bar' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        // note that while the server itself returns 503, the cloudron gets activated. this is just the way it is
        it('fails due to internal server error on appstore side', function (done) {
            var scope = nock(config.apiServerOrigin()).get('/api/v1/boxes/BOX_ID/setup/verify?setupToken=somesetuptoken').reply(500, { message: 'this is wrong' });

            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: 'someuser', password: 'strong#A3asdf', email: 'admin@foo.bar' })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(503);
                    expect(scope.isDone()).to.be.ok();
                    done();
                });
        });

        xit('succeeds', function (done) {
            var scope1 = nock(config.apiServerOrigin()).get('/api/v1/boxes/BOX_ID/setup/verify?setupToken=somesetuptoken').reply(200, {});
            var scope2 = nock(config.apiServerOrigin()).post('/api/v1/boxes/BOX_ID/setup/done?setupToken=somesetuptoken').reply(201, {});

            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: 'someuser', password: 'ADSF#asd546', email: 'admin@foo.bar', displayName: 'tester' })
                .end(function (error, result) {
                    console.dir(error);
                    expect(result.statusCode).to.equal(201);
                    expect(scope1.isDone()).to.be.ok();
                    expect(scope2.isDone()).to.be.ok();
                    done();
                });
        });
    });

    describe('get config', function () {
        before(setup);
        after(cleanup);

        it('succeeds (admin)', function (done) {
            var scope = nock(config.apiServerOrigin())
                .get('/api/v1/boxes/BOX_ID?token=ACCESS_TOKEN2')
                .reply(200, { box: { region: 'sfo', size: '1gb' }, user: { }});

            superagent.get(SERVER_URL + '/api/v1/cloudron/config')
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(200);
                    expect(result.body.apiServerOrigin).to.eql('http://localhost:6060');
                    expect(result.body.webServerOrigin).to.eql(null);
                    expect(result.body.adminFqdn).to.eql(config.adminFqdn());
                    expect(result.body.progress).to.be.an('object');
                    expect(result.body.update).to.be.an('object');
                    expect(result.body.version).to.eql(config.version());
                    expect(result.body.size).to.eql('1gb');
                    expect(result.body.region).to.eql('sfo');
                    expect(result.body.memory).to.eql(os.totalmem());
                    expect(result.body.cloudronName).to.be.a('string');
                    expect(result.body.provider).to.be.a('string');

                    expect(scope.isDone()).to.be.ok();

                    done();
                });
        });
    });

    describe('Backups API', function () {
        var scope1 = nock(config.apiServerOrigin()).post('/api/v1/boxes/BOX_ID/awscredentials?token=BACKUP_TOKEN')
            .reply(201, { credentials: { AccessKeyId: 'accessKeyId', SecretAccessKey: 'secretAccessKey' } }, { 'Content-Type': 'application/json' });

        before(setup);
        after(cleanup);

        it('calls the appstore after backup is done', function (done) {
            superagent.post(SERVER_URL + '/api/v1/backups')
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(202);

                    function checkAppstoreServerCalled() {
                        if (scope1.isDone()) return done();

                        setTimeout(checkAppstoreServerCalled, 100);
                    }

                    checkAppstoreServerCalled();
                });
        });
    });

    xdescribe('migrate', function () {
        before(function (done) {
            async.series([
                setup,

                function (callback) {
                    var scope1 = nock(config.apiServerOrigin()).get('/api/v1/boxes/BOX_ID/setup/verify?setupToken=somesetuptoken').reply(200, {});
                    var scope2 = nock(config.apiServerOrigin()).post('/api/v1/boxes/BOX_ID/setup/done?setupToken=somesetuptoken').reply(201, {});

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
                }
            ], done);
        });

        after(function (done) {
            locker.unlock(locker._operation); // migrate never unlocks
            cleanup(done);
        });

        it('fails without token', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/migrate')
                .send({ size: 'small', region: 'sfo'})
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('fails without password', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/migrate')
                .send({ size: 'small', region: 'sfo'})
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('succeeds without size', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/migrate')
                .send({ region: 'sfo', password: PASSWORD })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(202);
                    done();
                });
        });

        it('fails with wrong size type', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/migrate')
                .send({ size: 4, region: 'sfo', password: PASSWORD })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('succeeds without region', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/migrate')
                .send({ size: 'small', password: PASSWORD })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(202);
                    done();
                });
        });

        it('fails with wrong region type', function (done) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/migrate')
                .send({ size: 'small', region: 4, password: PASSWORD })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(400);
                    done();
                });
        });

        it('fails when in wrong state', function (done) {
            var scope2 = nock(config.apiServerOrigin())
                .post('/api/v1/boxes/BOX_ID/awscredentials?token=BACKUP_TOKEN')
                .reply(201, { credentials: { AccessKeyId: 'accessKeyId', SecretAccessKey: 'secretAccessKey', SessionToken: 'sessionToken' } });

            var scope3 = nock(config.apiServerOrigin())
                .post('/api/v1/boxes/BOX_ID/backupDone?token=APPSTORE_TOKEN', function (body) {
                    return body.boxVersion && body.restoreKey && !body.appId && !body.appVersion && body.appBackupIds.length === 0;
                })
                .reply(200, { id: 'someid' });

            var scope1 = nock(config.apiServerOrigin())
                .post('/api/v1/boxes/BOX_ID/migrate?token=APPSTORE_TOKEN', function (body) {
                    return body.size && body.region && body.restoreKey;
                }).reply(409, {});

            injectShellMock();

            superagent.post(SERVER_URL + '/api/v1/cloudron/migrate')
                .send({ size: 'small', region: 'sfo', password: PASSWORD })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(202);

                    function checkAppstoreServerCalled() {
                        if (scope1.isDone() && scope2.isDone() && scope3.isDone()) {
                            restoreShellMock();
                            return done();
                        }

                        setTimeout(checkAppstoreServerCalled, 100);
                    }

                    checkAppstoreServerCalled();
                });
        });

        it('succeeds', function (done) {
            var scope1 = nock(config.apiServerOrigin()).post('/api/v1/boxes/BOX_ID/migrate?token=APPSTORE_TOKEN', function (body) {
                return body.size && body.region && body.restoreKey;
            }).reply(202, {});

            var scope2 = nock(config.apiServerOrigin())
                .post('/api/v1/boxes/BOX_ID/backupDone?token=APPSTORE_TOKEN', function (body) {
                    return body.boxVersion && body.restoreKey && !body.appId && !body.appVersion && body.appBackupIds.length === 0;
                })
                .reply(200, { id: 'someid' });

            var scope3 = nock(config.apiServerOrigin())
                .post('/api/v1/boxes/BOX_ID/awscredentials?token=BACKUP_TOKEN')
                .reply(201, { credentials: { AccessKeyId: 'accessKeyId', SecretAccessKey: 'secretAccessKey', SessionToken: 'sessionToken' } });

            injectShellMock();

            superagent.post(SERVER_URL + '/api/v1/cloudron/migrate')
                .send({ size: 'small', region: 'sfo', password: PASSWORD })
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(202);

                    function checkAppstoreServerCalled() {
                        if (scope1.isDone() && scope2.isDone() && scope3.isDone()) {
                            restoreShellMock();
                            return done();
                        }

                        setTimeout(checkAppstoreServerCalled, 100);
                    }

                    checkAppstoreServerCalled();
                });
        });
    });
});

