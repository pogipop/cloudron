/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */
/* global beforeEach:false */

'use strict';

var async = require('async'),
    appstore = require('../appstore.js'),
    AppstoreError = appstore.AppstoreError,
    database = require('../database.js'),
    expect = require('expect.js'),
    nock = require('nock'),
    settings = require('../settings.js'),
    settingsdb = require('../settingsdb.js');

const ADMIN_DOMAIN = 'appstore-test.example.com';
const APPSTORE_TOKEN = 'appstoretoken';
const CLOUDRON_ID = 'cloudronid';
const APP_ID = 'appid';
const APPSTORE_APP_ID = 'appstoreappid';
const MOCK_API_SERVER_ORIGIN = 'http://localhost:6060';

function setup(done) {
    nock.cleanAll();

    async.series([
        database.initialize,
        database._clear,
        settings._setApiServerOrigin.bind(null, MOCK_API_SERVER_ORIGIN),
        settings.setAdmin.bind(null, ADMIN_DOMAIN, 'my.' + ADMIN_DOMAIN),
    ], done);
}

function cleanup(done) {
    nock.cleanAll();

    async.series([
        database._clear,
        database.uninitialize
    ], done);
}

describe('Appstore', function () {
    before(setup);
    after(cleanup);

    beforeEach(nock.cleanAll);

    it('cannot send alive status without registering', function (done) {
        appstore.sendAliveStatus(function (error) {
            expect(error).to.be.ok();
            expect(error.reason).to.equal(AppstoreError.NOT_REGISTERED);
            done();
        });
    });

    it('can set cloudron token', function (done) {
        settingsdb.set(settings.CLOUDRON_TOKEN_KEY, APPSTORE_TOKEN, done);
    });

    it('can send alive status', function (done) {
        var scope = nock(MOCK_API_SERVER_ORIGIN)
            .post(`/api/v1/alive?accessToken=${APPSTORE_TOKEN}`, function (body) {
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

        appstore.sendAliveStatus(function (error) {
            expect(error).to.not.be.ok();
            expect(scope.isDone()).to.be.ok();

            done();
        });
    });

    it('can purchase an app', function (done) {
        var scope1 = nock(MOCK_API_SERVER_ORIGIN)
            .post(`/api/v1/cloudronapps?accessToken=${APPSTORE_TOKEN}`, function () { return true; })
            .reply(201, {});

        appstore.purchaseApp({ appId: APP_ID, appstoreId: APPSTORE_APP_ID, manifestId: APPSTORE_APP_ID }, function (error) {
            expect(error).to.not.be.ok();
            expect(scope1.isDone()).to.be.ok();

            done();
        });
    });

    it('unpurchase succeeds if app was never purchased', function (done) {
        var scope1 = nock(MOCK_API_SERVER_ORIGIN)
            .get(`/api/v1/cloudronapps/${APP_ID}?accessToken=${APPSTORE_TOKEN}`)
            .reply(404, {});

        var scope2 = nock(MOCK_API_SERVER_ORIGIN)
            .delete(`/api/v1/cloudronapps/${APP_ID}?accessToken=${APPSTORE_TOKEN}`, function () { return true; })
            .reply(204, {});

        appstore.unpurchaseApp(APP_ID, { appstoreId: APPSTORE_APP_ID, manifestId: APPSTORE_APP_ID }, function (error) {
            expect(error).to.not.be.ok();
            expect(scope1.isDone()).to.be.ok();
            expect(scope2.isDone()).to.not.be.ok();

            done();
        });
    });

    it('can unpurchase an app', function (done) {
        var scope1 = nock(MOCK_API_SERVER_ORIGIN)
            .get(`/api/v1/cloudronapps/${APP_ID}?accessToken=${APPSTORE_TOKEN}`)
            .reply(200, {});

        var scope2 = nock(MOCK_API_SERVER_ORIGIN)
            .delete(`/api/v1/cloudronapps/${APP_ID}?accessToken=${APPSTORE_TOKEN}`, function () { return true; })
            .reply(204, {});

        appstore.unpurchaseApp(APP_ID, { appstoreId: APPSTORE_APP_ID, manifestId: APPSTORE_APP_ID }, function (error) {
            expect(error).to.not.be.ok();
            expect(scope1.isDone()).to.be.ok();
            expect(scope2.isDone()).to.be.ok();

            done();
        });
    });
});
