/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var appdb = require('../../appdb.js'),
    async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    hock = require('hock'),
    http = require('http'),
    nock = require('nock'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    settings = require('../../settings.js'),
    url = require('url');

var SERVER_URL = 'http://localhost:' + config.get('port');

var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';

function setup(done) {
    config.setVersion('1.2.3');

    async.series([
        server.start.bind(server),

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

                    callback();
                });
        },

        function addApp(callback) {
            var manifest = { version: '0.0.1', manifestVersion: 1, dockerImage: 'foo', healthCheckPath: '/', httpPort: 3, title: 'ok', addons: { } };
            appdb.add('appid', 'appStoreId', manifest, 'location', [ ] /* portBindings */, { }, callback);
        },

        function createSettings(callback) {
            settings.setBackupConfig({ provider: 'caas', token: 'BACKUP_TOKEN', bucket: 'Bucket', prefix: 'Prefix', format: 'tgz' }, callback);
        }
    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(!error).to.be.ok();

        server.stop(done);
    });
}

describe('Internal API', function () {
    before(setup);
    after(cleanup);

    var apiHockInstance = hock.createHock({ throwOnUnmatched: false }), apiHockServer;

    before(function (done) {
        apiHockInstance
            .post('/api/v1/boxes/' + config.fqdn() + '/awscredentials?token=BACKUP_TOKEN')
            .reply(201, { credentials: { AccessKeyId: 'accessKeyId', SecretAccessKey: 'secretAccessKey' } });
        var port = parseInt(url.parse(config.apiServerOrigin()).port, 10);
        apiHockServer = http.createServer(apiHockInstance.handler).listen(port, done);
    });

    after(function (done) {
        apiHockServer.close();
        done();
    });

    describe('backup', function () {
        it('succeeds', function (done) {
            superagent.post(config.sysadminOrigin() + '/api/v1/backup')
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(202);

                    function checkAppstoreServerCalled() {
                        apiHockInstance.done(function (error) {
                            if (!error) return done();

                            setTimeout(checkAppstoreServerCalled, 100);
                        });
                    }

                    checkAppstoreServerCalled();
                });
        });
    });
});
