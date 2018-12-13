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

let AUDIT_SOURCE = { ip: '1.2.3.4' };

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

    async.series([
        server.start.bind(server),

        database._clear,

        settingsdb.set.bind(null, settings.CAAS_CONFIG_KEY, JSON.stringify({ boxId: 'BOX_ID', token: 'ACCESS_TOKEN2' })),
        domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE),

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
                    expect(result.statusCode).to.equal(424);
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
});

