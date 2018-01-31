/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var appdb = require('../../appdb.js'),
    async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    domains = require('../../domains.js'),
    expect = require('expect.js'),
    hock = require('hock'),
    http = require('http'),
    MockS3 = require('mock-aws-s3'),
    os = require('os'),
    path = require('path'),
    rimraf = require('rimraf'),
    s3 = require('../../storage/s3.js'),
    safe = require('safetydance'),
    server = require('../../server.js'),
    settings = require('../../settings.js'),
    settingsdb = require('../../settingsdb.js'),
    superagent = require('superagent'),
    url = require('url');

const SERVER_URL = 'http://localhost:' + config.get('port');

const USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';

const DOMAIN_0 = {
    domain: 'example-sysadmin-test.com',
    zoneName: 'example-sysadmin-test.com',
    config: {},
    provider: 'noop',
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

function setup(done) {
    config._reset();
    config.setFqdn(DOMAIN_0.domain);
    config.setVersion('1.2.3');

    async.series([
        server.start,
        database._clear,
        domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig),

        function createAdmin(callback) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                .end(function (error, result) {
                    expect(result).to.be.ok();
                    expect(result.statusCode).to.eql(201);

                    callback();
                });
        },

        function addApp(callback) {
            var manifest = { version: '0.0.1', manifestVersion: 1, dockerImage: 'foo', healthCheckPath: '/', httpPort: 3, title: 'ok', addons: { } };
            appdb.add('appid', 'appStoreId', manifest, 'location', DOMAIN_0.domain, [ ] /* portBindings */, { }, callback);
        },

        function createSettings(callback) {
            MockS3.config.basePath = path.join(os.tmpdir(), 's3-sysadmin-test-buckets/');

            s3._mockInject(MockS3);

            safe.fs.mkdirSync('/tmp/box-sysadmin-test');
            settingsdb.set(settings.BACKUP_CONFIG_KEY, JSON.stringify({ provider: 'caas', token: 'BACKUP_TOKEN', fqdn: DOMAIN_0.domain, key: 'key', prefix: 'boxid', format: 'tgz'}), callback);
        }
    ], done);
}

function cleanup(done) {
    s3._mockRestore();
    rimraf.sync(MockS3.config.basePath);

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
            .post('/api/v1/boxes/' + config.adminDomain() + '/awscredentials?token=BACKUP_TOKEN')
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
