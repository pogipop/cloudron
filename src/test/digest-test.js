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

function checkMails(number, done) {
    // mails are enqueued async
    setTimeout(function () {
        expect(mailer._getMailQueue().length).to.equal(number);
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
                checkMails(0, done);
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

                checkMails(1, done);
            });
        });

        it('sends mail for pending update', function (done) {
            updatechecker._setUpdateInfo({ box: null, apps: { 'appid': { manifest: { version: '1.2.5', changelog: 'noop\nreally' } } } });

            digest.maybeSend(function (error) {
                if (error) return done(error);

                checkMails(1, done);
            });
        });
    });
});
