/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../config.js'),
    database = require('../database.js'),
    expect = require('expect.js'),
    mail = require('../mail.js'),
    maildb = require('../maildb.js');

const DOMAIN_0 = {
    domain: 'example.com',
    zoneName: 'example.com',
    provider: 'manual',
    config: { }
};

function setup(done) {
    config._reset();
    config.set('fqdn', 'example.com');
    config.set('provider', 'caas');

    async.series([
        database.initialize,
        database._clear,
        // DOMAIN_0 already added for test through domaindb.addDefaultDomain(),
        maildb.add.bind(null, DOMAIN_0.domain)
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

    describe('values', function () {
        it('can get default', function (done) {
            mail.get(DOMAIN_0.domain, function (error, mailConfig) {
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

                mail.get(DOMAIN_0.domain, function (error, mailConfig) {
                    expect(error).to.be(null);
                    expect(mailConfig.mailFromValidation).to.be(false);

                    done();
                });
            });
        });

        it('can set catch all address', function (done) {
            mail.setCatchAllAddress(DOMAIN_0.domain, [ 'user1', 'user2' ], function (error) {
                expect(error).to.be(null);

                mail.get(DOMAIN_0.domain, function (error, mailConfig) {
                    expect(error).to.be(null);
                    expect(mailConfig.catchAll).to.eql([ 'user1', 'user2' ]);
                    done();
                });
            });
        });

        it('can set mail relay', function (done) {
            var relay = { provider: 'external-smtp', host: 'mx.foo.com', port: 25 };

            mail.setMailRelay(DOMAIN_0.domain, relay, function (error) { // skip the mail server verify()
                expect(error).to.be(null);

                mail.get(DOMAIN_0.domain, function (error, mailConfig) {
                    expect(error).to.be(null);
                    expect(mailConfig.relay).to.eql(relay);
                    done();
                });
            });
        });

        it('can enable mail', function (done) {
            mail.setMailEnabled(DOMAIN_0.domain, true, function (error) {
                expect(error).to.be(null);

                mail.get(DOMAIN_0.domain, function (error, mailConfig) {
                    expect(error).to.be(null);
                    expect(mailConfig.enabled).to.be(true);
                    done();
                });
            });
        });
    });
});
