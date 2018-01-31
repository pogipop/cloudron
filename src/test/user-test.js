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
    user = require('../user.js'),
    userdb = require('../userdb.js'),
    UserError = user.UserError;

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
    groups.create('admin', function () { // ignore error since it might already exist
        user.createOwner(USERNAME, PASSWORD, EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
            expect(error).to.not.be.ok();
            expect(result).to.be.ok();

            userObject = result;

            done();
        });
    });
}

function setup(done) {
    config._reset();
    config.setFqdn(DOMAIN_0.domain);

    async.series([
        database.initialize,
        database._clear,
        domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig),
        mail.add.bind(null, DOMAIN_0.domain),
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
            user.create(USERNAME, 'Fo$%23', EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.BAD_FIELD);

                done();
            });
        });

        it('fails due to missing upper case password', function (done) {
            user.create(USERNAME, 'thisiseightch%$234arslong', EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.BAD_FIELD);

                done();
            });
        });

        it('fails due to missing numerics in password', function (done) {
            user.create(USERNAME, 'foobaRASDF%', EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.BAD_FIELD);

                done();
            });
        });

        it('fails due to missing special chars in password', function (done) {
            user.create(USERNAME, 'foobaRASDF23423', EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.BAD_FIELD);

                done();
            });
        });

        it('fails due to reserved username', function (done) {
            user.create('admin', PASSWORD, EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.BAD_FIELD);

                done();
            });
        });

        it('fails due to invalid username', function (done) {
            user.create('moo-daemon', PASSWORD, EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.BAD_FIELD);

                done();
            });
        });

        it('fails due to short username', function (done) {
            user.create('', PASSWORD, EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.BAD_FIELD);

                done();
            });
        });

        it('fails due to long username', function (done) {
            user.create(new Array(257).fill('Z').join(''), PASSWORD, EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.BAD_FIELD);

                done();
            });
        });

        it('fails due to reserved pattern', function (done) {
            user.create('maybe-app', PASSWORD, EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.BAD_FIELD);

                done();
            });
        });

        it('succeeds and attempts to send invite', function (done) {
            user.createOwner(USERNAME, PASSWORD, EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).not.to.be.ok();
                expect(result).to.be.ok();
                expect(result.username).to.equal(USERNAME.toLowerCase());
                expect(result.email).to.equal(EMAIL.toLowerCase());
                expect(result.fallbackEmail).to.equal(EMAIL.toLowerCase());

                // first user is owner, do not send mail to admins
                checkMails(0, done);
            });
        });

        it('fails because of invalid BAD_FIELD', function (done) {
            expect(function () {
                user.create(EMAIL, {}, function () {});
            }).to.throwException();
            expect(function () {
                user.create(12345, PASSWORD, EMAIL, function () {});
            }).to.throwException();
            expect(function () {
                user.create(USERNAME, PASSWORD, EMAIL, {});
            }).to.throwException();
            expect(function () {
                user.create(USERNAME, PASSWORD, EMAIL, {}, function () {});
            }).to.throwException();
            expect(function () {
                user.create(USERNAME, PASSWORD, EMAIL, {});
            }).to.throwException();
            expect(function () {
                user.create(USERNAME, PASSWORD, EMAIL, false, null, 'foobar');
            }).to.throwException();

            done();
        });

        it('fails because user exists', function (done) {
            user.create(USERNAME, PASSWORD, EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).not.to.be.ok();
                expect(error.reason).to.equal(UserError.ALREADY_EXISTS);

                done();
            });
        });

        it('fails because password is empty', function (done) {
            user.create(USERNAME, '', EMAIL, DISPLAY_NAME, AUDIT_SOURCE, function (error, result) {
                expect(error).to.be.ok();
                expect(result).not.to.be.ok();
                expect(error.reason).to.equal(UserError.BAD_FIELD);

                done();
            });
        });

        it('succeeds and attempts to send invite to fallbackEmail', function (done) {
            // use maildb to not trigger further events
            maildb.update(DOMAIN_0.domain, { enabled: true }, function (error) {
                expect(error).not.to.be.ok();

                user.create(USERNAME_1, PASSWORD_1, EMAIL_1, DISPLAY_NAME_1, AUDIT_SOURCE, { sendInvite: true }, function (error, result) {
                    expect(error).not.to.be.ok();
                    expect(result).to.be.ok();
                    expect(result.username).to.equal(USERNAME_1.toLowerCase());
                    expect(result.email).to.equal(EMAIL_1.toLowerCase());
                    expect(result.fallbackEmail).to.equal(EMAIL_1.toLowerCase());

                    // first user is owner, do not send mail to admins
                    checkMails(2, { sentTo: EMAIL_1.toLowerCase() }, function (error) {
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
            user.getOwner(function (error) {
                expect(error.reason).to.be(UserError.NOT_FOUND);
                done();
            });
        });

        it('succeeds', function (done) {
            createOwner(function (error) {
                if (error) return done(error);

                user.getOwner(function (error, owner) {
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
            user.verify('somerandomid', PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.NOT_FOUND);

                done();
            });
        });

        it('fails due to empty password', function (done) {
            user.verify(userObject.id, '', function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.WRONG_PASSWORD);

                done();
            });
        });

        it('fails due to wrong password', function (done) {
            user.verify(userObject.id, PASSWORD+PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.WRONG_PASSWORD);

                done();
            });
        });

        it('succeeds', function (done) {
            user.verify(userObject.id, PASSWORD, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                done();
            });
        });

        it('fails for ghost if not enabled', function (done) {
            user.verify(userObject.id, 'foobar', function (error) {
                expect(error).to.be.a(UserError);
                expect(error.reason).to.equal(UserError.WRONG_PASSWORD);
                done();
            });
        });

        it('fails for ghost with wrong password', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';
            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            user.verify(userObject.id, 'foobar', function (error) {
                fs.unlinkSync(constants.GHOST_USER_FILE);

                expect(error).to.be.a(UserError);
                expect(error.reason).to.equal(UserError.WRONG_PASSWORD);
                done();
            });
        });

        it('succeeds for ghost', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';
            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            user.verify(userObject.id, 'testpassword', function (error, result) {
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

            user.verify(userObject.id, PASSWORD, function (error, result) {
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
            user.verifyWithUsername(USERNAME+USERNAME, PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.NOT_FOUND);

                done();
            });
        });

        it('fails due to empty password', function (done) {
            user.verifyWithUsername(USERNAME, '', function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.WRONG_PASSWORD);

                done();
            });
        });

        it('fails due to wrong password', function (done) {
            user.verifyWithUsername(USERNAME, PASSWORD+PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.WRONG_PASSWORD);

                done();
            });
        });

        it('succeeds', function (done) {
            user.verifyWithUsername(USERNAME, PASSWORD, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                done();
            });
        });

        it('succeeds for different username case', function (done) {
            user.verifyWithUsername(USERNAME.toUpperCase(), PASSWORD, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                done();
            });
        });

        it('fails for ghost with wrong password', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';

            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            user.verifyWithUsername(USERNAME, 'foobar', function (error) {
                fs.unlinkSync(constants.GHOST_USER_FILE);

                expect(error).to.be.a(UserError);
                expect(error.reason).to.equal(UserError.WRONG_PASSWORD);
                done();
            });
        });

        it('succeeds for ghost', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';

            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            user.verifyWithUsername(USERNAME, 'testpassword', function (error, result) {
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
            user.verifyWithEmail(EMAIL+EMAIL, PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.NOT_FOUND);

                done();
            });
        });

        it('fails due to empty password', function (done) {
            user.verifyWithEmail(EMAIL, '', function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.WRONG_PASSWORD);

                done();
            });
        });

        it('fails due to wrong password', function (done) {
            user.verifyWithEmail(EMAIL, PASSWORD+PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.WRONG_PASSWORD);

                done();
            });
        });

        it('succeeds', function (done) {
            user.verifyWithEmail(EMAIL, PASSWORD, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                done();
            });
        });

        it('succeeds for different email case', function (done) {
            user.verifyWithEmail(EMAIL.toUpperCase(), PASSWORD, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                done();
            });
        });

        it('fails for ghost with wrong password', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';

            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            user.verifyWithEmail(EMAIL, 'foobar', function (error) {
                fs.unlinkSync(constants.GHOST_USER_FILE);

                expect(error).to.be.a(UserError);
                expect(error.reason).to.equal(UserError.WRONG_PASSWORD);
                done();
            });
        });

        it('succeeds for ghost', function (done) {
            var ghost = { };
            ghost[userObject.username] = 'testpassword';

            fs.writeFileSync(constants.GHOST_USER_FILE, JSON.stringify(ghost), 'utf8');

            user.verifyWithEmail(EMAIL, 'testpassword', function (error, result) {
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
            user.get('some non existing username', function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();

                done();
            });
        });

        it('succeeds', function (done) {
            user.get(userObject.id, function (error, result) {
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

                user.get(userObject.id, function (error, result) {
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
            user.update(USERNAME, data, AUDIT_SOURCE, function (error) {
                expect(error).to.be.a(UserError);
                expect(error.reason).to.equal(UserError.NOT_FOUND);

                done();
            });
        });

        it('fails due to invalid email', function (done) {
            var data = { username: USERNAME_NEW, email: 'brokenemailaddress', displayName: DISPLAY_NAME_NEW };
            user.update(userObject.id, data, AUDIT_SOURCE, function (error) {
                expect(error).to.be.a(UserError);
                expect(error.reason).to.equal(UserError.BAD_FIELD);

                done();
            });
        });

        it('succeeds', function (done) {
            var data = { username: USERNAME_NEW, email: EMAIL_NEW, displayName: DISPLAY_NAME_NEW };

            user.update(userObject.id, data, AUDIT_SOURCE, function (error) {
                expect(error).to.not.be.ok();

                user.get(userObject.id, function (error, result) {
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

            user.update(userObject.id, data, AUDIT_SOURCE, function (error) {
                expect(error).to.not.be.ok();

                user.get(userObject.id, function (error, result) {
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
        var groupObject;

        before(function (done) {
            createOwner(function (error) {
                expect(error).to.not.be.ok();

                groups.create(NON_ADMIN_GROUP, function (error, result) {
                    expect(error).to.be(null);
                    groupObject = result;

                    done();
                });
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
            user.create(user1.username, user1.password, user1.email, DISPLAY_NAME, AUDIT_SOURCE, { invitor: invitor }, function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.be.ok();

                user1.id = result.id;

                user.setGroups(user1.id, [ constants.ADMIN_GROUP_ID ], function (error) {
                    expect(error).to.not.be.ok();

                    // one mail for user creation, one mail for admin change
                    checkMails(2, done);
                });
            });
        });

        it('add user to non admin group does not trigger admin mail', function (done) {
            user.setGroups(user1.id, [ constants.ADMIN_GROUP_ID, groupObject.id ], function (error) {
                expect(error).to.equal(null);

                checkMails(0, done);
            });
        });

        it('succeeds to remove admin flag', function (done) {
            user.setGroups(user1.id, [ groupObject.id ], function (error) {
                expect(error).to.eql(null);

                checkMails(1, done);
            });
        });
    });

    describe('get admins', function () {
        before(createOwner);
        after(cleanupUsers);

        it('succeeds for one admins', function (done) {
            user.getAllAdmins(function (error, admins) {
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
            user.create(user1.username, user1.password, user1.email, DISPLAY_NAME, AUDIT_SOURCE, { invitor: invitor }, function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.be.ok();

                user1.id = result.id;

                groups.setGroups(user1.id, [ constants.ADMIN_GROUP_ID ], function (error) {
                    expect(error).to.eql(null);

                    user.getAllAdmins(function (error, admins) {
                        expect(error).to.eql(null);
                        expect(admins.length).to.equal(2);
                        expect(admins[0].username).to.equal(USERNAME.toLowerCase());
                        expect(admins[1].username).to.equal(user1.username.toLowerCase());

                        // one mail for user creation one mail for admin change
                        checkMails(1, done);    // FIXME should be 2 for admin change
                    });
                });
            });
        });
    });

    describe('count', function () {
        before(createOwner);
        after(cleanupUsers);

        it('succeeds', function (done) {
            user.count(function (error, count) {
                expect(error).to.not.be.ok();
                expect(count).to.be(1);
                done();
            });
        });
    });

    describe('set password', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails due to unknown user', function (done) {
            user.setPassword('doesnotexist', NEW_PASSWORD, function (error) {
                expect(error).to.be.ok();
                done();
            });
        });

        it('fails due to empty password', function (done) {
            user.setPassword(userObject.id, '', function (error) {
                expect(error).to.be.ok();
                done();
            });
        });

        it('fails due to invalid password', function (done) {
            user.setPassword(userObject.id, 'foobar', function (error) {
                expect(error).to.be.ok();
                done();
            });
        });

        it('succeeds', function (done) {
            user.setPassword(userObject.id, NEW_PASSWORD, function (error) {
                expect(error).to.not.be.ok();
                done();
            });
        });

        it('actually changed the password (unable to login with old pasword)', function (done) {
            user.verify(userObject.id, PASSWORD, function (error, result) {
                expect(error).to.be.ok();
                expect(result).to.not.be.ok();
                expect(error.reason).to.equal(UserError.WRONG_PASSWORD);
                done();
            });
        });

        it('actually changed the password (login with new password)', function (done) {
            user.verify(userObject.id, NEW_PASSWORD, function (error, result) {
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
            user.resetPasswordByIdentifier('unknown@mail.com', function (error) {
                expect(error).to.be.an(UserError);
                expect(error.reason).to.eql(UserError.NOT_FOUND);
                done();
            });
        });

        it('fails due to unkown username', function (done) {
            user.resetPasswordByIdentifier('unknown', function (error) {
                expect(error).to.be.an(UserError);
                expect(error.reason).to.eql(UserError.NOT_FOUND);
                done();
            });
        });

        it('succeeds with email', function (done) {
            user.resetPasswordByIdentifier(EMAIL, function (error) {
                expect(error).to.not.be.ok();
                checkMails(1, done);
            });
        });

        it('succeeds with username', function (done) {
            user.resetPasswordByIdentifier(USERNAME, function (error) {
                expect(error).to.not.be.ok();
                checkMails(1, done);
            });
        });
    });

    describe('send invite', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails for unknown user', function (done) {
            user.sendInvite('unknown user', { }, function (error) {
                expect(error).to.be.a(UserError);
                expect(error.reason).to.equal(UserError.NOT_FOUND);

                checkMails(0, done);
            });
        });

        it('succeeds', function (done) {
            user.sendInvite(userObject.id, { }, function (error) {
                expect(error).to.eql(null);
                checkMails(1, done);
            });
        });
    });

    describe('remove', function () {
        before(createOwner);
        after(cleanupUsers);

        it('fails for unknown user', function (done) {
            user.remove('unknown', { }, function (error) {
                expect(error.reason).to.be(UserError.NOT_FOUND);
                done();
            });
        });

        it('can remove valid user', function (done) {
            user.remove(userObject.id, { }, function (error) {
                expect(!error).to.be.ok();
                done();
            });
        });

        it('can re-create user after user was removed', createOwner);
    });
});
