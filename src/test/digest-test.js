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
    mailer = require('../mailer.js'),
    nock = require('nock'),
    paths = require('../paths.js'),
    safe = require('safetydance'),
    settings = require('../settings.js'),
    updatechecker = require('../updatechecker.js'),
    user = require('../user.js');

// owner
var USER_0 = {
    username: 'username0',
    password: 'Username0pass?1234',
    email: 'user0@email.com',
    displayName: 'User 0'
};

var AUDIT_SOURCE = {
    ip: '1.2.3.4'
};

function checkMails(number, email, done) {
    // mails are enqueued async
    setTimeout(function () {
        expect(mailer._getMailQueue().length).to.equal(number);

        if (number && email) {
            expect(mailer._getMailQueue()[0].to.indexOf(email)).to.not.equal(-1);
        }

        mailer._clearMailQueue();
        done();
    }, 500);
}

describe('digest', function () {
    function cleanup(done) {
        mailer._clearMailQueue();
        safe.fs.unlinkSync(paths.UPDATE_CHECKER_FILE);

        async.series([
            settings.uninitialize,
            database._clear
        ], done);
    }

    before(function (done) {
        config._reset();
        config.set('version', '1.0.0');
        config.set('apiServerOrigin', 'http://localhost:4444');
        config.set('provider', 'notcaas');
        safe.fs.unlinkSync(paths.UPDATE_CHECKER_FILE);

        async.series([
            database.initialize,
            database._clear,
            settings.initialize,
            user.createOwner.bind(null, USER_0.username, USER_0.password, USER_0.email, USER_0.displayName, AUDIT_SOURCE),
            eventlog.add.bind(null, eventlog.ACTION_UPDATE, AUDIT_SOURCE, { boxUpdateInfo: { sourceTarballUrl: 'xx', version: '1.2.3', changelog: [ 'good stuff' ] } }),
            mailer.start,
            mailer._clearMailQueue
        ], done);
    });

    after(cleanup);

    describe('disabled', function () {
        before(function (done) {
            settings.setEmailDigest(false, done);
        });

        it('does not send mail with digest disabled', function (done) {
            digest.maybeSend(function (error) {
                if (error) return done(error);
                checkMails(0, '', done);
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

                checkMails(1, '', done);
            });
        });

        it('sends mail for pending update', function (done) {
            updatechecker._setUpdateInfo({ box: null, apps: { 'appid': { manifest: { version: '1.2.5', changelog: 'noop\nreally' } } } });

            digest.maybeSend(function (error) {
                if (error) return done(error);

                checkMails(1, '', done);
            });
        });

        it('sends mail for pending update to appstore account email (caas)', function (done) {
            var subscription = {
                id: 'caas',
                created: 0,
                canceled_at: 0,
                status: 'active',
                plan: { id: 'caas' }
            };

            updatechecker._setUpdateInfo({ box: null, apps: { 'appid': { manifest: { version: '1.2.5', changelog: 'noop\nreally' } } } });
            var fake1 = nock(config.apiServerOrigin()).post(function (uri) { return uri.indexOf('/api/v1/users/test-user/cloudrons') >= 0; }).reply(201, { cloudron: { id: 'test-cloudron' }});
            var fake2 = nock(config.apiServerOrigin()).get(function (uri) { return uri.indexOf('/api/v1/users/test-user/cloudrons/test-cloudron/subscription') >= 0; }).reply(200, { subscription: subscription });
            var fake3 = nock(config.apiServerOrigin()).get('/api/v1/users/test-user?accessToken=test-token').reply(200, { profile: { id: 'test-user', email: 'test@email.com' } });

            settings.setAppstoreConfig({ userId: 'test-user', token: 'test-token', cloudronId: 'test-cloudron' }, function (error) {
                if (error) return done(error);

                digest.maybeSend(function (error) {
                    if (error) return done(error);

                    checkMails(1, 'test@email.com', function (error) {
                        if (error) return done(error);

                        expect(fake1.isDone()).to.be.ok();
                        expect(fake2.isDone()).to.be.ok();
                        expect(fake3.isDone()).to.be.ok();

                        done();
                    });
                });
            });
        });
    });
});
