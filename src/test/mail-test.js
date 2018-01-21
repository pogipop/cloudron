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
    settingsdb = require('../settingsdb.js');

function setup(done) {
    config._reset();
    config.set('fqdn', 'example.com');
    config.set('provider', 'caas');

    async.series([
        database.initialize,
    ], done);
}

function cleanup(done) {
    async.series([
        database._clear,
        database.uninitialize
    ], done);
}

describe('Settings', function () {
    describe('values', function () {
        before(setup);
        after(cleanup);

        it('can set mail from validation', function (done) {
            mail.setMailFromValidation(true, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can get mail from validation', function (done) {
            mail.getMailFromValidation(function (error, enabled) {
                expect(error).to.be(null);
                expect(enabled).to.be(true);
                done();
            });
        });

        it('can get catch all address', function (done) {
            mail.getCatchAllAddress(function (error, address) {
                expect(error).to.be(null);
                expect(address).to.eql([ ]);
                done();
            });
        });

        it('can set catch all address', function (done) {
            mail.setCatchAllAddress([ 'user1', 'user2' ], function (error) {
                expect(error).to.be(null);

                mail.getCatchAllAddress(function (error, address) {
                    expect(error).to.be(null);
                    expect(address).to.eql([ 'user1', 'user2' ]);
                    done();
                });
            });
        });

        it('can get mail relay', function (done) {
            mail.getMailRelay(function (error, address) {
                expect(error).to.be(null);
                expect(address).to.eql({ provider: 'cloudron-smtp' });
                done();
            });
        });

        it('can set mail relay', function (done) {
            var relay = { provider: 'external-smtp', host: 'mx.foo.com', port: 25 };
            settingsdb.set(mail.MAIL_RELAY_KEY, JSON.stringify(relay), function (error) { // skip the mail server verify()
                expect(error).to.be(null);

                mail.getMailRelay(function (error, address) {
                    expect(error).to.be(null);
                    expect(address).to.eql(relay);
                    done();
                });
            });
        });

        it('can set mail config', function (done) {
            mail.setMailConfig({ enabled: true }, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can get mail config', function (done) {
            mail.getMailConfig(function (error, mailConfig) {
                expect(error).to.be(null);
                expect(mailConfig.enabled).to.be(true);
                done();
            });
        });
    });
});
