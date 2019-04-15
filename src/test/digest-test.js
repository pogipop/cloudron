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
    userdb = require('../userdb.js'),
    users = require('../users.js');

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
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

var AUDIT_SOURCE = {
    ip: '1.2.3.4'
};

function checkMails(number, email, done) {
    // mails are enqueued async
    setTimeout(function () {
        expect(mailer._mailQueue.length).to.equal(number);

        if (number) {
            expect(mailer._mailQueue[0].to).to.equal(email);
        }

        mailer._mailQueue = [];
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

        mailer._mailQueue = [];

        async.series([
            database.initialize,
            database._clear,
            domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE),
            mail.addDomain.bind(null, DOMAIN_0.domain),
            users.createOwner.bind(null, USER_0.username, USER_0.password, USER_0.email, USER_0.displayName, AUDIT_SOURCE),
            function (callback) {
                userdb.getByUsername(USER_0.username, function (error, result) {
                    if (error) return callback(error);

                    USER_0.id = result.id;

                    users.update(USER_0.id, { fallbackEmail: USER_0.fallbackEmail }, AUDIT_SOURCE, callback);
                });
            },
            eventlog.add.bind(null, eventlog.ACTION_UPDATE, AUDIT_SOURCE, { taskId: 12, boxUpdateInfo: { sourceTarballUrl: 'xx', version: '1.2.3', changelog: [ 'good stuff' ] } }),
            maildb.update.bind(null, DOMAIN_0.domain, { enabled: true }),
        ], done);
    });

    after(function (done) {
        mailer._mailQueue = [];
        safe.fs.unlinkSync(paths.UPDATE_CHECKER_FILE);

        async.series([
            database._clear,
            database.uninitialize
        ], done);
    });

    describe('disabled', function () {
        before(function (done) {
            settings.setEmailDigest(false, done);
        });

        it('does not send mail with digest disabled', function (done) {
            digest.send(function (error) {
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
            digest.send(function (error) {
                if (error) return done(error);

                checkMails(1, `${USER_0.email}`, done);
            });
        });

        it('sends mail for pending update', function (done) {
            updatechecker._setUpdateInfo({ box: null, apps: { 'appid': { manifest: { version: '1.2.5', changelog: 'noop\nreally' } } } });

            digest.send(function (error) {
                if (error) return done(error);

                checkMails(1, `${USER_0.email}`, done);
            });
        });

        it('sends mail for pending update to owner account email', function (done) {
            updatechecker._setUpdateInfo({ box: null, apps: { 'appid': { manifest: { version: '1.2.5', changelog: 'noop\nreally' } } } });

            maildb.update(DOMAIN_0.domain, { enabled: true }, function (error) {
                if (error) return done(error);

                digest.send(function (error) {
                    if (error) return done(error);

                    checkMails(1, `${USER_0.email}`, done);
                });
            });
        });
    });
});
