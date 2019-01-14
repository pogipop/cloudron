/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../config.js'),
    database = require('../database.js'),
    constants = require('../constants.js'),
    expect = require('expect.js'),
    fs = require('fs'),
    groupdb = require('../groupdb.js'),
    groups = require('../groups.js'),
    domains = require('../domains.js'),
    mail = require('../mail.js'),
    mailboxdb = require('../mailboxdb.js'),
    maildb = require('../maildb.js'),
    mailer = require('../mailer.js'),
    userdb = require('../userdb.js'),
    users = require('../users.js'),
    UsersError = users.UsersError;

var USERNAME = 'noBody';
var USERNAME_NEW = 'noBodyNew';
var EMAIL = 'else@no.body';
var EMAIL_NEW = 'noBodyNew@no.body';
var PASSWORD = 'sTrOnG#$34134';
var NEW_PASSWORD = 'oTHER@#$235';
var DISPLAY_NAME = 'Nobody cares';
var DISPLAY_NAME_NEW = 'Somone cares';
var userObject = null;
var NON_ADMIN_GROUP = 'members';
var AUDIT_SOURCE = { ip: '1.2.3.4' };

var USERNAME_1 = 'secondUser';
var EMAIL_1 = 'second@user.com';
var PASSWORD_1 = 'Sup2345$@strong';
var DISPLAY_NAME_1 = 'Second User';

const DOMAIN_0 = {
    domain: 'example.com',
    zoneName: 'example.com',
    provider: 'manual',
    config: {},
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

function cleanupUsers(done) {
    async.series([
        groupdb._clear,
        userdb._clear,
        mailboxdb._clear,
        mailer._clearMailQueue
    ], done);
}

function createOwner(done) {
    users.createOwner(USERNAME, PASSWORD, EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
        expect(error).to.not.be.ok();
        expect(result).to.be.ok();

        userObject = result;

        done();
    });
}

function setup(done) {
    config._reset();
    config.setFqdn(DOMAIN_0.domain);

    async.series([
        database.initialize,
        database._clear,
        domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE),
        mail.addDomain.bind(null, DOMAIN_0.domain),
        mailer._clearMailQueue
    ], done);
}

function cleanup(done) {
    mailer._clearMailQueue();

    async.series([
        database._clear,
        database.uninitialize
    ], done);
}

function checkMails(number, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = null;
    }

    // mails are enqueued async
    setTimeout(function () {
        expect(mailer._getMailQueue().length).to.equal(number);

        if (options && options.sentTo) expect(mailer._getMailQueue().some(function (mail) { return mail.to === options.sentTo; }));

        mailer._clearMailQueue();

        callback();
    }, 500);
}

describe('User', function () {
    before(setup);
    after(cleanup);

    describe('create', function() {
        before(cleanupUsers);
        after(cleanupUsers);

        it('fails due to short password', function (done) {
            users.create(USERNAME, 'Fo$%23', EMAIL, DISPLAY_NAME, { }, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.BAD_FIELD);

                done();
            });
        });

        it('fails due to reserved username', function (done) {
            users.create('admin', PASSWORD, EMAIL, DISPLAY_NAME, { }, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.BAD_FIELD);

                done();
            });
        });

        it('fails due to invalid username', function (done) {
            users.create('moo+daemon', PASSWORD, EMAIL, DISPLAY_NAME, { }, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.BAD_FIELD);

                done();
            });
        });

        it('fails due to short username', function (done) {
            users.create('', PASSWORD, EMAIL, DISPLAY_NAME, { }, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.BAD_FIELD);

                done();
            });
        });

        it('fails due to long username', function (done) {
            users.create(new Array(257).fill('Z').join(''), PASSWORD, EMAIL, DISPLAY_NAME, { }, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.BAD_FIELD);

                done();
            });
        });

        it('fails due to reserved app pattern', function (done) {
            users.create('maybe.app', PASSWORD, EMAIL, DISPLAY_NAME, { }, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.BAD_FIELD);

                done();
            });
        });

        it('succeeds', function (done) {
            users.createOwner(USERNAME, PASSWORD, EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).not.to.be.ok();
                expect(result).to.be.ok();
                expect(result.username).to.equal(USERNAME.toLowerCase());
                expect(result.email).to.equal(EMAIL.toLowerCase());
                expect(result.fallbackEmail).to.equal(EMAIL.toLowerCase());

                done();
            });
        });

        it('fails because user exists', function (done) {
            users.create(USERNAME, PASSWORD, EMAIL, DISPLAY_NAME, { }, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).not.to.be.ok();
                expect(error.reason).to.equal(UsersError.ALREADY_EXISTS);

                done();
            });
        });

        it('fails because password is empty', function (done) {
            users.create(USERNAME, '', EMAIL, DISPLAY_NAME, { }, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).not.to.be.ok();
                expect(error.reason).to.equal(UsersError.BAD_FIELD);

                done();
            });
        });

        it('succeeds and attempts to send invite to fallbackEmail', function (done) {
            // use maildb to not trigger further events
            maildb.update(DOMAIN_0.domain, { enabled: true }, function (error) {
                expect(error).not.to.be.ok();

                users.create(USERNAME_1, PASSWORD_1, EMAIL_1, DISPLAY_NAME_1, { sendInvite: true }, AUDIT_SOURCE, function (error, result) {
                    expect(error).not.to.be.ok();
                    expect(result).to.be.ok();
                    expect(result.username).to.equal(USERNAME_1.toLowerCase());
                    expect(result.email).to.equal(EMAIL_1.toLowerCase());
                    expect(result.fallbackEmail).to.equal(EMAIL_1.toLowerCase());

                    // first user is owner, do not send mail to admins
                    checkMails(1, { sentTo: EMAIL_1.toLowerCase() }, function (error) {
                        expect(error).not.to.be.ok();

                        maildb.update(DOMAIN_0.domain, { enabled: false }, done);
                    });
                });
            });
        });
    });

    describe('getOwner', function() {
        before(cleanupUsers);
        after(cleanupUsers);

        it('fails because there is no owner', function (done) {
            users.getOwner(function (error) {
                expect(error.reason).to.be(UsersError.NOT_FOUND);
                done();
            });
        });

        it('succeeds', function (done) {
            createOwner(function (error) {
                if (error) return done(error);

                users.getOwner(function (error, owner) {
                    expect(error).to.be(null);
                    expect(owner.email).to.be(EMAIL.toLowerCase());
                    done();
                });
            });
        });
    });

    describe('verify', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails due to non existing user', function (done) {
            users.verify('somerandomid', PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.NOT_FOUND);

                done();
            });
        });

        it('fails due to empty password', function (done) {
            users.verify(userObject.id, '', function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.WRONG_PASSWORD);

                done();
            });
        });

        it('fails due to wrong password', function (done) {
            users.verify(userObject.id, PASSWORD+PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.WRONG_PASSWORD);

                done();
            });
        });

        it('succeeds', function (done) {
            users.verify(userObject.id, PASSWORD, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                done();
            });
        });

        it('fails for ghost if not enabled', function (done) {
            users.verify(userObject.id, 'foobar', function (error) {
                expect(error).to.be.a(UsersError);
                expect(error.reason).to.equal(UsersError.WRONG_PASSWORD);
                done();
            });
        });

        it('fails for ghost with wrong password', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';
            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            users.verify(userObject.id, 'foobar', function (error) {
                fs.unlinkSync(constants.GHOST_USER_FILE);

                expect(error).to.be.a(UsersError);
                expect(error.reason).to.equal(UsersError.WRONG_PASSWORD);
                done();
            });
        });

        it('succeeds for ghost', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';
            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            users.verify(userObject.id, 'testpassword', function (error, result) {
                fs.unlinkSync(constants.GHOST_USER_FILE);

                expect(error).to.equal(null);
                expect(result.id).to.equal(userObject.id);
                expect(result.username).to.equal(userObject.username);
                expect(result.email).to.equal(userObject.email);
                expect(result.displayName).to.equal(userObject.displayName);

                done();
            });
        });

        it('succeeds for normal user password when ghost file exists', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';
            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            users.verify(userObject.id, PASSWORD, function (error, result) {
                fs.unlinkSync(constants.GHOST_USER_FILE);

                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                done();
            });

        });
    });

    describe('verifyWithUsername', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails due to non existing username', function (done) {
            users.verifyWithUsername(USERNAME+USERNAME, PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.NOT_FOUND);

                done();
            });
        });

        it('fails due to empty password', function (done) {
            users.verifyWithUsername(USERNAME, '', function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.WRONG_PASSWORD);

                done();
            });
        });

        it('fails due to wrong password', function (done) {
            users.verifyWithUsername(USERNAME, PASSWORD+PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.WRONG_PASSWORD);

                done();
            });
        });

        it('succeeds', function (done) {
            users.verifyWithUsername(USERNAME, PASSWORD, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                done();
            });
        });

        it('succeeds for different username case', function (done) {
            users.verifyWithUsername(USERNAME.toUpperCase(), PASSWORD, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                done();
            });
        });

        it('fails for ghost with wrong password', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';

            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            users.verifyWithUsername(USERNAME, 'foobar', function (error) {
                fs.unlinkSync(constants.GHOST_USER_FILE);

                expect(error).to.be.a(UsersError);
                expect(error.reason).to.equal(UsersError.WRONG_PASSWORD);
                done();
            });
        });

        it('succeeds for ghost', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';

            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            users.verifyWithUsername(USERNAME, 'testpassword', function (error, result) {
                fs.unlinkSync(constants.GHOST_USER_FILE);

                expect(error).to.equal(null);
                expect(result.id).to.equal(userObject.id);
                expect(result.username).to.equal(userObject.username);
                expect(result.email).to.equal(userObject.email);
                expect(result.displayName).to.equal(userObject.displayName);

                done();
            });
        });
    });

    describe('verifyWithEmail', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails due to non existing user', function (done) {
            users.verifyWithEmail(EMAIL+EMAIL, PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.NOT_FOUND);

                done();
            });
        });

        it('fails due to empty password', function (done) {
            users.verifyWithEmail(EMAIL, '', function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.WRONG_PASSWORD);

                done();
            });
        });

        it('fails due to wrong password', function (done) {
            users.verifyWithEmail(EMAIL, PASSWORD+PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.WRONG_PASSWORD);

                done();
            });
        });

        it('succeeds', function (done) {
            users.verifyWithEmail(EMAIL, PASSWORD, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                done();
            });
        });

        it('succeeds for different email case', function (done) {
            users.verifyWithEmail(EMAIL.toUpperCase(), PASSWORD, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                done();
            });
        });

        it('fails for ghost with wrong password', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';

            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            users.verifyWithEmail(EMAIL, 'foobar', function (error) {
                fs.unlinkSync(constants.GHOST_USER_FILE);

                expect(error).to.be.a(UsersError);
                expect(error.reason).to.equal(UsersError.WRONG_PASSWORD);
                done();
            });
        });

        it('succeeds for ghost', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';

            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            users.verifyWithEmail(EMAIL, 'testpassword', function (error, result) {
                fs.unlinkSync(constants.GHOST_USER_FILE);

                expect(error).to.equal(null);
                expect(result.id).to.equal(userObject.id);
                expect(result.username).to.equal(userObject.username);
                expect(result.email).to.equal(userObject.email);
                expect(result.displayName).to.equal(userObject.displayName);

                done();
            });
        });
    });

    describe('retrieving', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails due to non existing user', function (done) {
            users.get('some non existing username', function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();

                done();
            });
        });

        it('succeeds', function (done) {
            users.get(userObject.id, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();
                expect(result.id).to.equal(userObject.id);
                expect(result.email).to.equal(EMAIL.toLowerCase());
                expect(result.fallbackEmail).to.equal(EMAIL.toLowerCase());
                expect(result.username).to.equal(USERNAME.toLowerCase());
                expect(result.displayName).to.equal(DISPLAY_NAME);

                done();
            });
        });

        it('succeeds with email enabled', function (done) {
            // use maildb to not trigger further events
            maildb.update(DOMAIN_0.domain, { enabled: true }, function (error) {
                expect(error).not.to.be.ok();

                users.get(userObject.id, function (error, result) {
                    expect(error).to.not.be.ok();
                    expect(result).to.be.ok();
                    expect(result.id).to.equal(userObject.id);
                    expect(result.email).to.equal(EMAIL.toLowerCase());
                    expect(result.fallbackEmail).to.equal(EMAIL.toLowerCase());
                    expect(result.username).to.equal(USERNAME.toLowerCase());
                    expect(result.displayName).to.equal(DISPLAY_NAME);

                    maildb.update(DOMAIN_0.domain, { enabled: false }, done);
                });
            });
        });
    });

    describe('update', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails due to unknown userid', function (done) {
            var data = { username: USERNAME_NEW, email: EMAIL_NEW, displayName: DISPLAY_NAME_NEW };
            users.update(USERNAME, data, AUDIT_SOURCE, function (error) {
                expect(error).to.be.a(UsersError);
                expect(error.reason).to.equal(UsersError.NOT_FOUND);

                done();
            });
        });

        it('fails due to invalid email', function (done) {
            var data = { username: USERNAME_NEW, email: 'brokenemailaddress', displayName: DISPLAY_NAME_NEW };
            users.update(userObject.id, data, AUDIT_SOURCE, function (error) {
                expect(error).to.be.a(UsersError);
                expect(error.reason).to.equal(UsersError.BAD_FIELD);

                done();
            });
        });

        it('succeeds', function (done) {
            var data = { username: USERNAME_NEW, email: EMAIL_NEW, displayName: DISPLAY_NAME_NEW };

            users.update(userObject.id, data, AUDIT_SOURCE, function (error) {
                expect(error).to.not.be.ok();

                users.get(userObject.id, function (error, result) {
                    expect(error).to.not.be.ok();
                    expect(result).to.be.ok();
                    expect(result.email).to.equal(EMAIL_NEW.toLowerCase());
                    expect(result.username).to.equal(USERNAME_NEW.toLowerCase());
                    expect(result.displayName).to.equal(DISPLAY_NAME_NEW);

                    done();
                });
            });
        });

        it('succeeds with same data', function (done) {
            var data = { username: USERNAME_NEW, email: EMAIL_NEW, displayName: DISPLAY_NAME_NEW };

            users.update(userObject.id, data, AUDIT_SOURCE, function (error) {
                expect(error).to.not.be.ok();

                users.get(userObject.id, function (error, result) {
                    expect(error).to.not.be.ok();
                    expect(result).to.be.ok();
                    expect(result.email).to.equal(EMAIL_NEW.toLowerCase());
                    expect(result.username).to.equal(USERNAME_NEW.toLowerCase());
                    expect(result.displayName).to.equal(DISPLAY_NAME_NEW);

                    done();
                });
            });
        });
    });

    describe('admin change triggers mail', function () {
        before(function (done) {
            createOwner(function (error) {
                expect(error).to.not.be.ok();

                groups.create(NON_ADMIN_GROUP, done);
            });
        });

        after(cleanupUsers);

        var user1 = {
            username: 'seconduser',
            password: 'ASDFkljsf#$^%2354',
            email: 'some@thi.ng'
        };

        it('make second user admin succeeds', function (done) {

            var invitor = { username: USERNAME, email: EMAIL };
            users.create(user1.username, user1.password, user1.email, DISPLAY_NAME, { invitor: invitor }, AUDIT_SOURCE, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                user1.id = result.id;

                users.update(user1.id, { admin: true }, { ip: '1.2.3.4' }, function (error) {
                    expect(error).to.not.be.ok();

                    // one mail for user creation, one mail for admin change
                    checkMails(2, done);
                });
            });
        });

        it('succeeds to remove admin flag', function (done) {
            users.update(user1.id, { admin: false }, { ip: '1.2.3.4' }, function (error) {
                expect(error).to.eql(null);

                checkMails(1, done);
            });
        });
    });

    describe('get admins', function () {
        before(createOwner);
        after(cleanupUsers);

        it('succeeds for one admins', function (done) {
            users.getAllAdmins(function (error, admins) {
                expect(error).to.eql(null);
                expect(admins.length).to.equal(1);
                expect(admins[0].username).to.equal(USERNAME.toLowerCase());
                done();
            });
        });

        it('succeeds for two admins', function (done) {
            var user1 = {
                username: 'seconduser',
                password: 'Adfasdkjf#$%43',
                email: 'some@thi.ng'
            };

            var invitor = { username: USERNAME, email: EMAIL };
            users.create(user1.username, user1.password, user1.email, DISPLAY_NAME, { invitor: invitor }, AUDIT_SOURCE, function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.be.ok();

                user1.id = result.id;

                users.update(user1.id, { admin: true }, { ip: '1.2.3.4' }, function (error) {
                    expect(error).to.eql(null);

                    users.getAllAdmins(function (error, admins) {
                        expect(error).to.eql(null);
                        expect(admins.length).to.equal(2);
                        expect(admins[0].username).to.equal(USERNAME.toLowerCase());
                        expect(admins[1].username).to.equal(user1.username.toLowerCase());

                        checkMails(2, done); // one mail for user creation one mail for admin change
                    });
                });
            });
        });
    });

    describe('activated', function () {
        after(cleanupUsers);

        it('succeeds with no users', function (done) {
            users.isActivated(function (error, activated) {
                expect(error).to.not.be.ok();
                expect(activated).to.be(false);
                done();
            });
        });

        it('create users', function (done) {
            createOwner(done);
        });

        it('succeeds with users', function (done) {
            users.isActivated(function (error, activated) {
                expect(error).to.not.be.ok();
                expect(activated).to.be(true);
                done();
            });
        });
    });

    describe('set password', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails due to unknown user', function (done) {
            users.setPassword('doesnotexist', NEW_PASSWORD, function (error) {
                expect(error).to.be.ok();
                done();
            });
        });

        it('fails due to empty password', function (done) {
            users.setPassword(userObject.id, '', function (error) {
                expect(error).to.be.ok();
                done();
            });
        });

        it('fails due to invalid password', function (done) {
            users.setPassword(userObject.id, 'foobar', function (error) {
                expect(error).to.be.ok();
                done();
            });
        });

        it('succeeds', function (done) {
            users.setPassword(userObject.id, NEW_PASSWORD, function (error) {
                expect(error).to.not.be.ok();
                done();
            });
        });

        it('actually changed the password (unable to login with old pasword)', function (done) {
            users.verify(userObject.id, PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UsersError.WRONG_PASSWORD);
                done();
            });
        });

        it('actually changed the password (login with new password)', function (done) {
            users.verify(userObject.id, NEW_PASSWORD, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();
                done();
            });
        });
    });

    describe('resetPasswordByIdentifier', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails due to unkown email', function (done) {
            users.resetPasswordByIdentifier('unknown@mail.com', function (error) {
                expect(error).to.be.an(UsersError);
                expect(error.reason).to.eql(UsersError.NOT_FOUND);
                done();
            });
        });

        it('fails due to unkown username', function (done) {
            users.resetPasswordByIdentifier('unknown', function (error) {
                expect(error).to.be.an(UsersError);
                expect(error.reason).to.eql(UsersError.NOT_FOUND);
                done();
            });
        });

        it('succeeds with email', function (done) {
            users.resetPasswordByIdentifier(EMAIL, function (error) {
                expect(error).to.not.be.ok();
                checkMails(1, done);
            });
        });

        it('succeeds with username', function (done) {
            users.resetPasswordByIdentifier(USERNAME, function (error) {
                expect(error).to.not.be.ok();
                checkMails(1, done);
            });
        });
    });

    describe('invite', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails for unknown user', function (done) {
            users.sendInvite('unknown user', { }, function (error) {
                expect(error).to.be.a(UsersError);
                expect(error.reason).to.equal(UsersError.NOT_FOUND);

                checkMails(0, done);
            });
        });

        it('fails as expected', function (done) {
            users.sendInvite(userObject.id, { }, function (error) {
                expect(error).to.be.ok(); // have to create resetToken first
                done();
            });
        });

        it('can create token', function (done) {
            users.createInvite(userObject.id, function (error, resetToken) {
                expect(error).to.be(null);
                expect(resetToken).to.be.ok();
                done();
            });
        });

        it('send invite', function (done) {
            users.sendInvite(userObject.id, { }, function (error) {
                expect(error).to.be(null);
                checkMails(1, done);
            });
        });
    });

    describe('remove', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails for unknown user', function (done) {
            users.remove('unknown', { }, function (error) {
                expect(error.reason).to.be(UsersError.NOT_FOUND);
                done();
            });
        });

        it('can remove valid user', function (done) {
            users.remove(userObject.id, { }, function (error) {
                expect(!error).to.be.ok();
                done();
            });
        });

        it('can re-create user after user was removed', createOwner);
    });
});
