/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */
/* global beforeEach:false */

'use strict';

var async = require('async'),
    config = require('../config.js'),
    database = require('../database.js'),
    domains = require('../domains.js'),
    expect = require('expect.js'),
    mail = require('../mail.js'),
    MailError = mail.MailError,
    maildb = require('../maildb.js'),
    nock = require('nock'),
    settings = require('../settings.js');

const DOMAIN_0 = {
    domain: 'example.com',
    zoneName: 'example.com',
    provider: 'manual',
    config: {},
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

const APPSTORE_USER_ID = 'appstoreuserid';
const APPSTORE_TOKEN = 'appstoretoken';
const CLOUDRON_ID = 'cloudronid';

function setup(done) {
    config._reset();
    config.set('fqdn', 'example.com');
    config.set('provider', 'caas');

    async.series([
        database.initialize,
        database._clear,
        settings.initialize,
        domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig),
        mail.addDomain.bind(null, DOMAIN_0.domain),
        function (callback) {
            var scope = nock('http://localhost:6060')
                .post(`/api/v1/users/${APPSTORE_USER_ID}/cloudrons?accessToken=${APPSTORE_TOKEN}`, function () { return true; })
                .reply(201, { cloudron: { id: CLOUDRON_ID }});

            settings.setAppstoreConfig({ userId: APPSTORE_USER_ID, token: APPSTORE_TOKEN }, function (error) {
                expect(error).to.not.be.ok();
                expect(scope.isDone()).to.be.ok();

                callback();
            });
        }
    ], done);
}

function cleanup(done) {
    async.series([
        settings.uninitialize,
        database._clear,
        database.uninitialize
    ], done);
}

describe('Mail', function () {
    before(setup);
    after(cleanup);

    beforeEach(nock.cleanAll);

    describe('values', function () {
        it('can get default', function (done) {
            mail.getDomain(DOMAIN_0.domain, function (error, mailConfig) {
                expect(error).to.be(null);
                expect(mailConfig.enabled).to.be(false);
                expect(mailConfig.mailFromValidation).to.be(true);
                expect(mailConfig.catchAll).to.eql([]);
                expect(mailConfig.relay).to.eql({ provider: 'cloudron-smtp' });
                done();
            });
        });

        it('can set mail from validation', function (done) {
            mail.setMailFromValidation(DOMAIN_0.domain, false, function (error) {
                expect(error).to.be(null);

                mail.getDomain(DOMAIN_0.domain, function (error, mailConfig) {
                    expect(error).to.be(null);
                    expect(mailConfig.mailFromValidation).to.be(false);

                    done();
                });
            });
        });

        it('can set catch all address', function (done) {
            mail.setCatchAllAddress(DOMAIN_0.domain, [ 'user1', 'user2' ], function (error) {
                expect(error).to.be(null);

                mail.getDomain(DOMAIN_0.domain, function (error, mailConfig) {
                    expect(error).to.be(null);
                    expect(mailConfig.catchAll).to.eql([ 'user1', 'user2' ]);
                    done();
                });
            });
        });

        it('can set mail relay', function (done) {
            var relay = { provider: 'external-smtp', host: 'mx.foo.com', port: 25 };

            maildb.update(DOMAIN_0.domain, { relay: relay }, function (error) { // skip the mail server verify()
                expect(error).to.be(null);

                mail.getDomain(DOMAIN_0.domain, function (error, mailConfig) {
                    expect(error).to.be(null);
                    expect(mailConfig.relay).to.eql(relay);
                    done();
                });
            });
        });

        it('cannot enable mail without a subscription', function (done) {
            var scope = nock('http://localhost:6060')
                .get(`/api/v1/users/${APPSTORE_USER_ID}/cloudrons/${CLOUDRON_ID}/subscription?accessToken=${APPSTORE_TOKEN}`, function () { return true; })
                .reply(200, { subscription: { id: 'free', plan: { id: 'free' }}});

            mail.setMailEnabled(DOMAIN_0.domain, true, function (error) {
                expect(error).to.be.a(MailError);
                expect(error.reason).to.equal(MailError.BILLING_REQUIRED);
                expect(scope.isDone()).to.be.ok();
                done();
            });
        });

        it('can enable mail', function (done) {
            var scope = nock('http://localhost:6060')
                .get(`/api/v1/users/${APPSTORE_USER_ID}/cloudrons/${CLOUDRON_ID}/subscription?accessToken=${APPSTORE_TOKEN}`, function () { return true; })
                .reply(200, { subscription: { id: 'basic', plan: { id: 'basic' }}});

            mail.setMailEnabled(DOMAIN_0.domain, true, function (error) {
                expect(error).to.be(null);
                expect(scope.isDone()).to.be.ok();

                mail.getDomain(DOMAIN_0.domain, function (error, mailConfig) {
                    expect(error).to.be(null);
                    expect(mailConfig.enabled).to.be(true);
                    done();
                });
            });
        });
    });
});
