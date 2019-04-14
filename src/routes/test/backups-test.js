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
    nock = require('nock'),
    superagent = require('superagent'),
    server = require('../../server.js'),
    settings = require('../../settings.js');

const SERVER_URL = 'http://localhost:' + config.get('port');

const USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';

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

function setup(done) {
    nock.cleanAll();
    config._reset();

    async.series([
        server.start,
        database._clear,
        domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE),

        function createAdmin(callback) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                .end(function (error, result) {
                    expect(result).to.be.ok();
                    expect(result.statusCode).to.eql(201);

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

describe('Backups API', function () {
    before(setup);

    after(cleanup);

    describe('create', function () {
        it('fails due to mising token', function (done) {
            superagent.post(SERVER_URL + '/api/v1/backups/create')
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('fails due to wrong token', function (done) {
            superagent.post(SERVER_URL + '/api/v1/backups/create')
                .query({ access_token: token.toUpperCase() })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(401);
                    done();
                });
        });

        it('succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/backups/create')
                .query({ access_token: token })
                .end(function (error, result) {
                    expect(result.statusCode).to.equal(202);

                    done();
                });
        });
    });
});
