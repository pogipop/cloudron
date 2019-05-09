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
    maildb = require('../maildb.js'),
    nock = require('nock');

const DOMAIN_0 = {
    domain: 'example.com',
    zoneName: 'example.com',
    provider: 'manual',
    config: {},
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

const AUDIT_SOURCE = {
    ip: '1.2.3.4'
};

function setup(done) {
    config._reset();
    config.set('fqdn', 'example.com');
    config.set('provider', 'digitalocean');

    async.series([
        database.initialize,
        database._clear,
        domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE),
        mail.addDomain.bind(null, DOMAIN_0.domain)
    ], done);
}

function cleanup(done) {
    async.series([
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

        it('can enable mail', function (done) {
            mail.setMailEnabled(DOMAIN_0.domain, true, AUDIT_SOURCE, function (error) {
                expect(error).to.be(null);

                mail.getDomain(DOMAIN_0.domain, function (error, mailConfig) {
                    expect(error).to.be(null);
                    expect(mailConfig.enabled).to.be(true);
                    done();
                });
            });
        });
    });
});
