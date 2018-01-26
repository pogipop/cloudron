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
    maildb = require('../maildb.js'),
    mailer = require('../mailer.js'),
    mail = require('../mail.js'),
    domains = require('../domains.js'),
    paths = require('../paths.js'),
    safe = require('safetydance'),
    settings = require('../settings.js'),
    updatechecker = require('../updatechecker.js'),
    user = require('../user.js'),
    userdb = require('../userdb.js');

// owner
var USER_0 = {
    username: 'username0',
    password: 'Username0pass?1234',
    email: 'user0@email.com',
    fallbackEmail: 'user0fallback@email.com',
    displayName: 'User 0'
};

const DOMAIN_0 = {
    domain: 'example.com',
    zoneName: 'example.com',
    config: {},
    provider: 'manual',
    fallbackCertificate: null
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
            domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate),
            mail.add.bind(null, DOMAIN_0.domain),
            user.createOwner.bind(null, USER_0.username, USER_0.password, USER_0.email, USER_0.displayName, AUDIT_SOURCE),
            function (callback) {
                userdb.getByUsername(USER_0.username, function (error, result) {
                    if (error) return callback(error);

                    USER_0.id = result.id;

                    user.update(USER_0.id, { fallbackEmail: USER_0.fallbackEmail }, AUDIT_SOURCE, callback);
                });
            },
            eventlog.add.bind(null, eventlog.ACTION_UPDATE, AUDIT_SOURCE, { boxUpdateInfo: { sourceTarballUrl: 'xx', version: '1.2.3', changelog: [ 'good stuff' ] } }),
            maildb.update.bind(null, DOMAIN_0.domain, { enabled: true }),
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

                checkMails(1, `${USER_0.fallbackEmail}, ${USER_0.email}`, done);
            });
        });

        it('sends mail for pending update', function (done) {
            updatechecker._setUpdateInfo({ box: null, apps: { 'appid': { manifest: { version: '1.2.5', changelog: 'noop\nreally' } } } });

            digest.maybeSend(function (error) {
                if (error) return done(error);

                checkMails(1, `${USER_0.fallbackEmail}, ${USER_0.email}`, done);
            });
        });

        it('sends mail for pending update to owner account email', function (done) {
            updatechecker._setUpdateInfo({ box: null, apps: { 'appid': { manifest: { version: '1.2.5', changelog: 'noop\nreally' } } } });

            maildb.update(DOMAIN_0.domain, { enabled: true }, function (error) {
                if (error) return done(error);

                digest.maybeSend(function (error) {
                    if (error) return done(error);

                    checkMails(1, `${USER_0.fallbackEmail}, ${USER_0.email}`, done);
                });
            });
        });
    });
});
