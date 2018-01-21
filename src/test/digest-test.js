/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../config.js'),
    database = require('../database.js'),
    digest = require('../digest.js'),
    eventlog = require('../eventlog.js'),
    expect = require('expect.js'),
    mail = require('../mail.js'),
    mailer = require('../mailer.js'),
    paths = require('../paths.js'),
    safe = require('safetydance'),
    settings = require('../settings.js'),
    settingsdb = require('../settingsdb.js'),
    updatechecker = require('../updatechecker.js'),
    user = require('../user.js');

// owner
var USER_0 = {
    username: 'username0',
    password: 'Username0pass?1234',
    email: 'user0@email.com',
    displayName: 'User 0'
};

const DOMAIN_0 = {
    domain: 'example.com',
    zoneName: 'example.com',
    config: { provider: 'manual' }
};

var AUDIT_SOURCE = {
    ip: '1.2.3.4'
};

function checkMails(number, email, done) {
    // mails are enqueued async
    setTimeout(function () {
        expect(mailer._getMailQueue().length).to.equal(number);

        if (number) {
            expect(mailer._getMailQueue()[0].to).to.equal(email);
        }

        mailer._clearMailQueue();
        done();
    }, 500);
}

describe('digest', function () {
    before(function (done) {
        config._reset();
        config.set('fqdn', 'domain.com');
        config.set('apiServerOrigin', 'http://localhost:4444');
        config.set('provider', 'notcaas');
        config.setFqdn(DOMAIN_0.domain);
        safe.fs.unlinkSync(paths.UPDATE_CHECKER_FILE);

        async.series([
            database.initialize,
            database._clear,
            settings.initialize,
            user.createOwner.bind(null, USER_0.username, USER_0.password, USER_0.email, USER_0.displayName, AUDIT_SOURCE),
            eventlog.add.bind(null, eventlog.ACTION_UPDATE, AUDIT_SOURCE, { boxUpdateInfo: { sourceTarballUrl: 'xx', version: '1.2.3', changelog: [ 'good stuff' ] } }),
            settingsdb.set.bind(null, mail.MAIL_CONFIG_KEY, JSON.stringify({ enabled: true })),
            mailer._clearMailQueue
        ], done);
    });

    after(function (done) {
        mailer._clearMailQueue();
        safe.fs.unlinkSync(paths.UPDATE_CHECKER_FILE);

        async.series([
            settings.uninitialize,
            database._clear,
            database.uninitialize
        ], done);
    });

    describe('disabled', function () {
        before(function (done) {
            settings.setEmailDigest(false, done);
        });

        it('does not send mail with digest disabled', function (done) {
            digest.maybeSend(function (error) {
                if (error) return done(error);
                checkMails(0, null, done);
            });
        });

    });

    describe('enabled', function () {
        before(function (done) {
            settings.setEmailDigest(true, done);
        });

        it('sends mail for box update', function (done) {
            digest.maybeSend(function (error) {
                if (error) return done(error);

                checkMails(1, `${USER_0.email}, ${USER_0.username}@${config.fqdn()}`, done);
            });
        });

        it('sends mail for pending update', function (done) {
            updatechecker._setUpdateInfo({ box: null, apps: { 'appid': { manifest: { version: '1.2.5', changelog: 'noop\nreally' } } } });

            digest.maybeSend(function (error) {
                if (error) return done(error);

                checkMails(1, `${USER_0.email}, ${USER_0.username}@${config.fqdn()}`, done);
            });
        });

        it('sends mail for pending update to owner account email', function (done) {
            updatechecker._setUpdateInfo({ box: null, apps: { 'appid': { manifest: { version: '1.2.5', changelog: 'noop\nreally' } } } });

            settingsdb.set(mail.MAIL_CONFIG_KEY, JSON.stringify({ enabled: true }), function (error) {
                if (error) return done(error);

                digest.maybeSend(function (error) {
                    if (error) return done(error);

                    checkMails(1, `${USER_0.email}, ${USER_0.username}@${DOMAIN_0.domain}`, done);
                });
            });
        });
    });
});
