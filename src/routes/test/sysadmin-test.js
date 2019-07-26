/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    constants = require('../../constants.js'),
    database = require('../../database.js'),
    domains = require('../../domains.js'),
    eventlog = require('../../eventlog.js'),
    expect = require('expect.js'),
    server = require('../../server.js'),
    settings = require('../../settings.js'),
    settingsdb = require('../../settingsdb.js'),
    superagent = require('superagent');

const SERVER_URL = 'http://localhost:' + constants.PORT;

const USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';

const DOMAIN_0 = {
    domain: 'example-sysadmin-test.com',
    zoneName: 'example-sysadmin-test.com',
    config: {},
    provider: 'noop',
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

let AUDIT_SOURCE = { ip: '1.2.3.4' };

function setup(done) {
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
                    callback();
                });
        },

        function createSettings(callback) {
            settingsdb.set(settings.BACKUP_CONFIG_KEY, JSON.stringify({ provider: 'filesystem', backupFolder: '/tmp/backups', prefix: 'boxid', format: 'tgz'}), callback);
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

    describe('backup', function () {
        it('succeeds', function (done) {
            superagent.post(`http://127.0.0.1:${constants.SYSADMIN_PORT}/api/v1/backup`)
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
