/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    appstore = require('../appstore.js'),
    AppstoreError = appstore.AppstoreError,
    config = require('../config.js'),
    database = require('../database.js'),
    expect = require('expect.js'),
    nock = require('nock'),
    settings = require('../settings.js');

const DOMAIN = 'example-appstore-test.com';
const APPSTORE_USER_ID = 'appstoreuserid';
const APPSTORE_TOKEN = 'appstoretoken';
const CLOUDRON_ID = 'cloudronid';

function setup(done) {
    nock.cleanAll();
    config.setFqdn(DOMAIN);
    config.setAdminFqdn('my.' + DOMAIN);

    async.series([
        database.initialize,
        database._clear,
        settings.initialize
    ], done);
}

function cleanup(done) {
    nock.cleanAll();

    async.series([
        settings.uninitialize,
        database._clear,
        database.uninitialize
    ], done);
}

describe('Appstore', function () {
    before(setup);
    after(cleanup);

    it('cannot send alive status without appstore config', function (done) {
        appstore.sendAliveStatus(function (error) {
            expect(error).to.be.ok();
            expect(error.reason).to.equal(AppstoreError.BILLING_REQUIRED);
            done();
        });
    });

    it('can send alive status', function (done) {
        var scope0 = nock('http://localhost:6060')
            .post(`/api/v1/users/${APPSTORE_USER_ID}/cloudrons?accessToken=${APPSTORE_TOKEN}`, function () { return true; })
            .reply(201, { cloudron: { id: CLOUDRON_ID }});
        var scope1 = nock('http://localhost:6060')
            .post(`/api/v1/users/${APPSTORE_USER_ID}/cloudrons/${CLOUDRON_ID}/alive?accessToken=${APPSTORE_TOKEN}`, function (body) {
                expect(body.version).to.be.a('string');
                expect(body.adminFqdn).to.be.a('string');
                expect(body.provider).to.be.a('string');
                expect(body.backendSettings).to.be.an('object');
                expect(body.backendSettings.backupConfig).to.be.an('object');
                expect(body.backendSettings.backupConfig.provider).to.be.a('string');
                expect(body.backendSettings.backupConfig.hardlinks).to.be.a('boolean');
                expect(body.backendSettings.domainConfig).to.be.an('object');
                expect(body.backendSettings.domainConfig.count).to.be.a('number');
                expect(body.backendSettings.domainConfig.domains).to.be.an('array');
                expect(body.backendSettings.mailConfig).to.be.an('object');
                expect(body.backendSettings.mailConfig.outboundCount).to.be.a('number');
                expect(body.backendSettings.mailConfig.inboundCount).to.be.a('number');
                expect(body.backendSettings.mailConfig.catchAllCount).to.be.a('number');
                expect(body.backendSettings.mailConfig.relayProviders).to.be.an('array');
                expect(body.backendSettings.appAutoupdatePattern).to.be.a('string');
                expect(body.backendSettings.boxAutoupdatePattern).to.be.a('string');
                expect(body.backendSettings.timeZone).to.be.a('string');
                expect(body.machine).to.be.an('object');
                expect(body.machine.cpus).to.be.an('array');
                expect(body.machine.totalmem).to.be.an('number');
                expect(body.events).to.be.an('object');
                expect(body.events.lastLogin).to.be.an('number');

                return true;
            })
            .reply(201, { cloudron: { id: CLOUDRON_ID }});

        settings.setAppstoreConfig({ userId: APPSTORE_USER_ID, token: APPSTORE_TOKEN }, function (error) {
            expect(error).to.not.be.ok();
            expect(scope0.isDone()).to.be.ok();

            appstore.sendAliveStatus(function (error) {
                expect(error).to.not.be.ok();
                expect(scope1.isDone()).to.be.ok();

                done();
            });
        });
    });
});

