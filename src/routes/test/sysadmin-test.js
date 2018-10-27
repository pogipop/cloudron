/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    domains = require('../../domains.js'),
    eventlog = require('../../eventlog.js'),
    expect = require('expect.js'),
    server = require('../../server.js'),
    settings = require('../../settings.js'),
    settingsdb = require('../../settingsdb.js'),
    superagent = require('superagent');

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

        function createSettings(callback) {
            settingsdb.set(settings.BACKUP_CONFIG_KEY, JSON.stringify({ provider: 'caas', token: 'BACKUP_TOKEN', fqdn: DOMAIN_0.domain, key: 'key', prefix: 'boxid', format: 'tgz'}), callback);
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
    this.timeout(5000);

    before(setup);
    after(cleanup);

    describe('backup', function () {
        it('succeeds', function (done) {
            superagent.post(config.sysadminOrigin() + '/api/v1/backup')
              .end(function (error, result) {
                expect(result.statusCode).to.equal(202);

                function checkBackupStartEvent() {
                    eventlog.getAllPaged([ eventlog.ACTION_BACKUP_START ], '', 1, 100, function (error, result) {
                        expect(error).to.equal(null);

                        if (result.length === 0) return setTimeout(checkBackupStartEvent, 1000);

                        done();
                    });
                }

                checkBackupStartEvent();
            });
        });
    });
});
