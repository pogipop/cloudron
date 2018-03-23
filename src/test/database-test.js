/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var appdb = require('../appdb.js'),
    async = require('async'),
    authcodedb = require('../authcodedb.js'),
    backupdb = require('../backupdb.js'),
    clientdb = require('../clientdb.js'),
    config = require('../config.js'),
    database = require('../database'),
    DatabaseError = require('../databaseerror.js'),
    domaindb = require('../domaindb'),
    eventlogdb = require('../eventlogdb.js'),
    expect = require('expect.js'),
    groupdb = require('../groupdb.js'),
    hat = require('hat'),
    mailboxdb = require('../mailboxdb.js'),
    maildb = require('../maildb.js'),
    settingsdb = require('../settingsdb.js'),
    tokendb = require('../tokendb.js'),
    userdb = require('../userdb.js'),
    _ = require('underscore');

var USER_0 = {
    id: 'uuid0',
    username: 'uuid0',
    password: 'secret',
    email: 'safe@me.com',
    fallbackEmail: 'safer@me.com',
    salt: 'morton',
    createdAt: 'sometime back',
    modifiedAt: 'now',
    resetToken: hat(256),
    displayName: ''
};

var USER_1 = {
    id: 'uuid1',
    username: 'uuid1',
    password: 'secret',
    email: 'safe2@me.com',
    fallbackEmail: 'safer2@me.com',
    salt: 'tata',
    createdAt: 'sometime back',
    modifiedAt: 'now',
    resetToken: '',
    displayName: 'Herbert 1'
};

var USER_2 = {
    id: 'uuid2',
    username: 'uuid2',
    password: 'secret',
    email: 'safe3@me.com',
    fallbackEmail: 'safer3@me.com',
    salt: 'tata',
    createdAt: 'sometime back',
    modifiedAt: 'now',
    resetToken: '',
    displayName: 'Herbert 2'
};

const DOMAIN_0 = {
    domain: 'foobar.com',
    zoneName: 'foobar.com',
    provider: 'digitalocean',
    config: { token: 'abcd' },
    tlsConfig: { provider: 'fallback' }
};

const DOMAIN_1 = {
    domain: 'foo.cloudron.io',
    zoneName: 'cloudron.io',
    provider: 'manual',
    config: null,
    tlsConfig: { provider: 'fallback' }
};

const TEST_DOMAIN = {
    domain: 'example.com',
    zoneName: 'example.com',
    provider: 'manual',
    config: {},
    tlsConfig: { provider: 'fallback' }
};

describe('database', function () {
    before(function (done) {
        config._reset();
        config.setFqdn(TEST_DOMAIN.domain);

        async.series([
            database.initialize,
            database._clear
        ], done);
    });

    after(function (done) {
        async.series([
            database._clear,
            database.uninitialize
        ], done);
    });

    describe('domains', function () {
        it('can add domain', function (done) {
            domaindb.add(DOMAIN_0.domain, { zoneName: DOMAIN_0.zoneName, provider: DOMAIN_0.provider, config: DOMAIN_0.config, tlsConfig: DOMAIN_0.tlsConfig }, done);
        });

        it('can add another domain', function (done) {
            domaindb.add(DOMAIN_1.domain, { zoneName: DOMAIN_1.zoneName, provider: DOMAIN_1.provider, config: DOMAIN_1.config, tlsConfig: DOMAIN_1.tlsConfig }, done);
        });

        it('cannot add same domain twice', function (done) {
            domaindb.add(DOMAIN_0.domain, { zoneName: DOMAIN_0.zoneName, provider: DOMAIN_0.provider, config: DOMAIN_0.config, tlsConfig: DOMAIN_0.tlsConfig }, function (error) {
                expect(error).to.be.ok();
                expect(error.reason).to.be(DatabaseError.ALREADY_EXISTS);
                done();
            });
        });

        it('can get domain', function (done) {
            domaindb.get(DOMAIN_0.domain, function (error, result) {
                expect(error).to.equal(null);
                expect(result).to.be.an('object');
                expect(result.domain).to.equal(DOMAIN_0.domain);
                expect(result.zoneName).to.equal(DOMAIN_0.zoneName);
                expect(result.config).to.eql(DOMAIN_0.config);

                done();
            });
        });

        it('can update domain', function (done) {
            const newConfig = { provider: 'manual' };
            const newTlsConfig = { provider: 'foobar' };

            domaindb.update(DOMAIN_1.domain, { provider: DOMAIN_1.provider, config: newConfig, tlsConfig: newTlsConfig }, function (error) {
                expect(error).to.equal(null);

                domaindb.get(DOMAIN_1.domain, function (error, result) {
                    expect(error).to.equal(null);
                    expect(result).to.be.an('object');
                    expect(result.domain).to.equal(DOMAIN_1.domain);
                    expect(result.zoneName).to.equal(DOMAIN_1.zoneName);
                    expect(result.provider).to.equal(DOMAIN_1.provider);
                    expect(result.config).to.eql(newConfig);
                    expect(result.tlsConfig).to.eql(newTlsConfig);

                    DOMAIN_1.config = newConfig;
                    DOMAIN_1.tlsConfig = newTlsConfig;

                    done();
                });
            });
        });

        it('can get all domains', function (done) {
            domaindb.getAll(function (error, result) {
                expect(error).to.equal(null);
                expect(result).to.be.an('array');
                expect(result.length).to.equal(2);

                // sorted by domain
                expect(result[0].domain).to.equal(DOMAIN_1.domain);
                expect(result[0].zoneName).to.equal(DOMAIN_1.zoneName);
                expect(result[0].provider).to.equal(DOMAIN_1.provider);
                expect(result[0].config).to.eql(DOMAIN_1.config);
                expect(result[0].tlsConfig).to.eql(DOMAIN_1.tlsConfig);

                expect(result[1].domain).to.equal(DOMAIN_0.domain);
                expect(result[1].zoneName).to.equal(DOMAIN_0.zoneName);
                expect(result[1].provider).to.equal(DOMAIN_0.provider);
                expect(result[1].config).to.eql(DOMAIN_0.config);
                expect(result[1].tlsConfig).to.eql(DOMAIN_0.tlsConfig);

                done();
            });
        });

        it('cannot delete non-existing domain', function (done) {
            domaindb.del('not.exists', function (error) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.equal(DatabaseError.NOT_FOUND);

                done();
            });
        });

        var APP_0 = {
            id: 'appid-0',
            appStoreId: 'appStoreId-0',
            dnsRecordId: null,
            installationState: appdb.ISTATE_PENDING_INSTALL,
            installationProgress: null,
            runState: null,
            location: 'some-location-0',
            domain: DOMAIN_0.domain,
            manifest: { version: '0.1', dockerImage: 'docker/app0', healthCheckPath: '/', httpPort: 80, title: 'app0' },
            httpPort: null,
            containerId: null,
            portBindings: { port: 5678 },
            health: null,
            accessRestriction: null,
            lastBackupId: null,
            oldConfig: null,
            newConfig: null,
            memoryLimit: 4294967296,
            xFrameOptions: 'DENY',
            sso: true,
            debugMode: null,
            robotsTxt: null,
            enableBackup: true
        };

        it('cannot delete referenced domain', function (done) {
            appdb.add(APP_0.id, APP_0.appStoreId, APP_0.manifest, APP_0.location, APP_0.domain, APP_0.portBindings, APP_0, function (error) {
                expect(error).to.be(null);

                domaindb.del(DOMAIN_0.domain, function (error) {
                    expect(error).to.be.a(DatabaseError);
                    expect(error.reason).to.equal(DatabaseError.IN_USE);

                    appdb.del(APP_0.id, done);
                });
            });
        });

        it('can delete existing domain', function (done) {
            domaindb.del(DOMAIN_0.domain, function (error) {
                expect(error).to.be(null);

                domaindb.get(DOMAIN_0.domain, function (error) {
                    expect(error).to.be.a(DatabaseError);
                    expect(error.reason).to.equal(DatabaseError.NOT_FOUND);

                    done();
                });
            });
        });
    });

    describe('user', function () {
        it('can add user', function (done) {
            userdb.add(USER_0.id, USER_0, done);
        });

        it('can add another user', function (done) {
            userdb.add(USER_1.id, USER_1, done);
        });

        it('can add another user with empty username', function (done) {
            userdb.add(USER_2.id, USER_2, done);
        });

        it('cannot add user width same email again', function (done) {
            var tmp = JSON.parse(JSON.stringify(USER_0));
            tmp.id = 'somethingelse';
            tmp.username = 'somethingelse';

            userdb.add(tmp.id, tmp, function (error) {
                expect(error).to.be.ok();
                expect(error.reason).to.be(DatabaseError.ALREADY_EXISTS);
                expect(error.message).to.equal('email already exists');
                done();
            });
        });

        it('cannot add user width same username again', function (done) {
            var tmp = JSON.parse(JSON.stringify(USER_0));
            tmp.id = 'somethingelse';
            tmp.email = 'somethingelse@not.taken';

            userdb.add(tmp.id, tmp, function (error) {
                expect(error).to.be.ok();
                expect(error.reason).to.be(DatabaseError.ALREADY_EXISTS);
                expect(error.message).to.equal('username already exists');
                done();
            });
        });

        it('can get by user id', function (done) {
            userdb.get(USER_0.id, function (error, user) {
                expect(error).to.not.be.ok();
                expect(user).to.eql(USER_0);
                done();
            });
        });

        it('can get by user name', function (done) {
            userdb.getByUsername(USER_0.username, function (error, user) {
                expect(error).to.not.be.ok();
                expect(user).to.eql(USER_0);
                done();
            });
        });

        it('can get by email', function (done) {
            userdb.getByEmail(USER_0.email, function (error, user) {
                expect(error).to.not.be.ok();
                expect(user).to.eql(USER_0);
                done();
            });
        });

        it('can get by resetToken fails for empty resetToken', function (done) {
            userdb.getByResetToken('', function (error, user) {
                expect(error).to.be.ok();
                expect(error.reason).to.be(DatabaseError.INTERNAL_ERROR);
                expect(user).to.not.be.ok();
                done();
            });
        });

        it('can get by resetToken', function (done) {
            userdb.getByResetToken(USER_0.resetToken, function (error, user) {
                expect(error).to.not.be.ok();
                expect(user).to.eql(USER_0);
                done();
            });
        });

        it('can get all with group ids', function (done) {
            userdb.getAllWithGroupIds(function (error, all) {
                expect(error).to.not.be.ok();
                expect(all.length).to.equal(3);

                var userCopy;

                userCopy = _.extend({}, USER_0);
                userCopy.groupIds = [ ];
                expect(all[0]).to.eql(userCopy);

                userCopy = _.extend({}, USER_1);
                userCopy.groupIds = [ ];
                expect(all[1]).to.eql(userCopy);

                userCopy = _.extend({}, USER_2);
                userCopy.groupIds = [ ];
                expect(all[2]).to.eql(userCopy);

                done();
            });
        });

        it('can get all admins', function (done) {
            userdb.getAllAdmins(function (error, all) {
                expect(error).to.not.be.ok();
                expect(all.length).to.equal(0);
                done();
            });
        });

        it('counts the users', function (done) {
            userdb.count(function (error, count) {
                expect(error).to.not.be.ok();
                expect(count).to.equal(3);
                done();
            });
        });

        it('can update the user', function (done) {
            userdb.update(USER_0.id, { email: 'some@thing.com', displayName: 'Heiter' }, function (error) {
                expect(error).to.not.be.ok();
                userdb.get(USER_0.id, function (error, user) {
                    expect(user.email).to.equal('some@thing.com');
                    expect(user.displayName).to.equal('Heiter');
                    done();
                });
            });
        });

        it('can update the user with already existing email', function (done) {
            userdb.update(USER_0.id, { email: USER_2.email }, function (error) {
                expect(error).to.be.ok();
                expect(error.reason).to.be(DatabaseError.ALREADY_EXISTS);
                expect(error.message).to.equal('email already exists');
                done();
            });
        });

        it('can update the user with already existing username', function (done) {
            userdb.update(USER_0.id, { username: USER_2.username }, function (error) {
                expect(error).to.be.ok();
                expect(error.reason).to.be(DatabaseError.ALREADY_EXISTS);
                expect(error.message).to.equal('username already exists');
                done();
            });
        });

        it('cannot update with null field', function () {
            expect(function () {
                userdb.update(USER_0.id, { email: null }, function () {});
            }).to.throwError();
        });

        it('cannot del non-existing user', function (done) {
            userdb.del(USER_0.id + USER_0.id, function (error) {
                expect(error).to.be.ok();
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                done();
            });
        });

        it('can del existing user', function (done) {
            userdb.del(USER_0.id, function (error) {
                expect(error).to.not.be.ok();
                done();
            });
        });

        it('did remove the user', function (done) {
            userdb.count(function (error, count) {
                expect(count).to.equal(2);
                done();
            });
        });
    });

    describe('authcode', function () {
        var AUTHCODE_0 = {
            authCode: 'authcode-0',
            clientId: 'clientid-0',
            userId: 'userid-0',
            expiresAt: Date.now() + 500000
        };
        var AUTHCODE_1 = {
            authCode: 'authcode-1',
            clientId: 'clientid-1',
            userId: 'userid-1',
            expiresAt: Date.now() + 500000
        };
        var AUTHCODE_2 = {
            authCode: 'authcode-2',
            clientId: 'clientid-2',
            userId: 'userid-2',
            expiresAt: Date.now()
        };

        it('add fails due to missing arguments', function () {
            expect(function () { authcodedb.add(AUTHCODE_0.authCode, AUTHCODE_0.clientId, AUTHCODE_0.userId); }).to.throwError();
            expect(function () { authcodedb.add(AUTHCODE_0.authCode, AUTHCODE_0.clientId, function () {}); }).to.throwError();
            expect(function () { authcodedb.add(AUTHCODE_0.authCode, function () {}); }).to.throwError();
        });

        it('add succeeds', function (done) {
            authcodedb.add(AUTHCODE_0.authCode, AUTHCODE_0.clientId, AUTHCODE_0.userId, AUTHCODE_0.expiresAt, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('add of same authcode fails', function (done) {
            authcodedb.add(AUTHCODE_0.authCode, AUTHCODE_0.clientId, AUTHCODE_0.userId, AUTHCODE_0.expiresAt, function (error) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.ALREADY_EXISTS);
                done();
            });
        });

        it('get succeeds', function (done) {
            authcodedb.get(AUTHCODE_0.authCode, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.be.an('object');
                expect(result).to.be.eql(AUTHCODE_0);
                done();
            });
        });

        it('get of nonexisting code fails', function (done) {
            authcodedb.get(AUTHCODE_1.authCode, function (error, result) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                expect(result).to.not.be.ok();
                done();
            });
        });

        it('get of expired code fails', function (done) {
            authcodedb.add(AUTHCODE_2.authCode, AUTHCODE_2.clientId, AUTHCODE_2.userId, AUTHCODE_2.expiresAt, function (error) {
                expect(error).to.be(null);

                authcodedb.get(AUTHCODE_2.authCode, function (error, result) {
                    expect(error).to.be.a(DatabaseError);
                    expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                    expect(result).to.not.be.ok();
                    done();
                });
            });
        });

        it('delExpired succeeds', function (done) {
            authcodedb.delExpired(function (error, result) {
                expect(error).to.not.be.ok();
                expect(result).to.eql(1);

                authcodedb.get(AUTHCODE_2.authCode, function (error, result) {
                    expect(error).to.be.a(DatabaseError);
                    expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                    expect(result).to.not.be.ok();
                    done();
                });
            });
        });

        it('delete succeeds', function (done) {
            authcodedb.del(AUTHCODE_0.authCode, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('cannot delete previously delete record', function (done) {
            authcodedb.del(AUTHCODE_0.authCode, function (error) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                done();
            });
        });
    });

    describe('token', function () {
        var TOKEN_0 = {
            accessToken: tokendb.generateToken(),
            identifier: '0',
            clientId: 'clientid-0',
            expires: Date.now() + 60 * 60000,
            scope: '*'
        };
        var TOKEN_1 = {
            accessToken: tokendb.generateToken(),
            identifier: '1',
            clientId: 'clientid-1',
            expires: Number.MAX_SAFE_INTEGER,
            scope: '*'
        };
        var TOKEN_2 = {
            accessToken: tokendb.generateToken(),
            identifier: '2',
            clientId: 'clientid-2',
            expires: Date.now(),
            scope: '*'
        };

        it('add fails due to missing arguments', function () {
            expect(function () { tokendb.add(TOKEN_0.accessToken, TOKEN_0.identifier, TOKEN_0.clientId, TOKEN_0.scope); }).to.throwError();
            expect(function () { tokendb.add(TOKEN_0.accessToken, TOKEN_0.identifier, TOKEN_0.clientId, function () {}); }).to.throwError();
            expect(function () { tokendb.add(TOKEN_0.accessToken, TOKEN_0.identifier, function () {}); }).to.throwError();
            expect(function () { tokendb.add(TOKEN_0.accessToken, function () {}); }).to.throwError();
        });

        it('add succeeds', function (done) {
            tokendb.add(TOKEN_0.accessToken, TOKEN_0.identifier, TOKEN_0.clientId, TOKEN_0.expires, TOKEN_0.scope, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('add of same token fails', function (done) {
            tokendb.add(TOKEN_0.accessToken, TOKEN_0.identifier, TOKEN_0.clientId, TOKEN_0.expires, TOKEN_0.scope, function (error) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.ALREADY_EXISTS);
                done();
            });
        });

        it('get succeeds', function (done) {
            tokendb.get(TOKEN_0.accessToken, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.be.an('object');
                expect(result).to.be.eql(TOKEN_0);
                done();
            });
        });

        it('get of nonexisting token fails', function (done) {
            tokendb.get(TOKEN_1.accessToken, function (error, result) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                expect(result).to.not.be.ok();
                done();
            });
        });

        it('getByIdentifier succeeds', function (done) {
            tokendb.getByIdentifier(TOKEN_0.identifier, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.equal(1);
                expect(result[0]).to.be.an('object');
                expect(result[0]).to.be.eql(TOKEN_0);
                done();
            });
        });

        it('delete succeeds', function (done) {
            tokendb.del(TOKEN_0.accessToken, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('getByIdentifier succeeds after token deletion', function (done) {
            tokendb.getByIdentifier(TOKEN_0.identifier, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.equal(0);
                done();
            });
        });

        it('delByIdentifier succeeds', function (done) {
            tokendb.add(TOKEN_1.accessToken, TOKEN_1.identifier, TOKEN_1.clientId, TOKEN_1.expires, TOKEN_1.scope, function (error) {
                expect(error).to.be(null);

                tokendb.delByIdentifier(TOKEN_1.identifier, function (error) {
                    expect(error).to.be(null);
                    done();
                });
            });
        });

        it('cannot delete previously delete record', function (done) {
            tokendb.del(TOKEN_0.accessToken, function (error) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                done();
            });
        });

        it('getByIdentifierAndClientId succeeds', function (done) {
            tokendb.add(TOKEN_0.accessToken, TOKEN_0.identifier, TOKEN_0.clientId, TOKEN_0.expires, TOKEN_0.scope, function (error) {
                expect(error).to.be(null);

                tokendb.getByIdentifierAndClientId(TOKEN_0.identifier, TOKEN_0.clientId, function (error, result) {
                    expect(error).to.be(null);
                    expect(result).to.be.an(Array);
                    expect(result.length).to.equal(1);
                    expect(result[0]).to.eql(TOKEN_0);
                    done();
                });
            });
        });

        it('delExpired succeeds', function (done) {
            tokendb.add(TOKEN_2.accessToken, TOKEN_2.identifier, TOKEN_2.clientId, TOKEN_2.expires, TOKEN_2.scope, function (error) {
                expect(error).to.be(null);

                tokendb.delExpired(function (error, result) {
                    expect(error).to.not.be.ok();
                    expect(result).to.eql(1);

                    tokendb.get(TOKEN_2.accessToken, function (error, result) {
                        expect(error).to.be.a(DatabaseError);
                        expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                        expect(result).to.not.be.ok();
                        done();
                    });
                });
            });
        });

        it('delByIdentifierAndClientId succeeds', function (done) {
            tokendb.delByIdentifierAndClientId(TOKEN_0.identifier, TOKEN_0.clientId, function (error) {
                expect(error).to.be(null);

                tokendb.get(TOKEN_0.accessToken, function (error, result) {
                    expect(error).to.be.a(DatabaseError);
                    expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                    expect(result).to.not.be.ok();
                    done();
                });
            });
        });

        it('delByClientId succeeds', function (done) {
            tokendb.add(TOKEN_0.accessToken, TOKEN_0.identifier, TOKEN_0.clientId, TOKEN_0.expires, TOKEN_0.scope, function (error) {
                expect(error).to.be(null);

                tokendb.delByClientId(TOKEN_0.clientId, function (error, result) {
                    expect(error).to.not.be.ok();

                    tokendb.get(TOKEN_0.accessToken, function (error, result) {
                        expect(error).to.be.a(DatabaseError);
                        expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                        expect(result).to.not.be.ok();
                        done();
                    });
                });
            });
        });
    });

    describe('app', function () {
        var APP_0 = {
            id: 'appid-0',
            appStoreId: 'appStoreId-0',
            dnsRecordId: null,
            installationState: appdb.ISTATE_PENDING_INSTALL,
            installationProgress: null,
            runState: null,
            location: 'some-location-0',
            domain: DOMAIN_0.domain,
            manifest: { version: '0.1', dockerImage: 'docker/app0', healthCheckPath: '/', httpPort: 80, title: 'app0' },
            httpPort: null,
            containerId: null,
            portBindings: { port: 5678 },
            health: null,
            accessRestriction: null,
            restoreConfig: null,
            oldConfig: null,
            updateConfig: null,
            memoryLimit: 4294967296,
            xFrameOptions: 'DENY',
            sso: true,
            debugMode: null,
            robotsTxt: null,
            enableBackup: true
        };

        var APP_1 = {
            id: 'appid-1',
            appStoreId: 'appStoreId-1',
            dnsRecordId: null,
            installationState: appdb.ISTATE_PENDING_INSTALL, // app health tests rely on this initial state
            installationProgress: null,
            runState: null,
            location: 'some-location-1',
            domain: DOMAIN_0.domain,
            manifest: { version: '0.2', dockerImage: 'docker/app1', healthCheckPath: '/', httpPort: 80, title: 'app1' },
            httpPort: null,
            containerId: null,
            portBindings: { },
            health: null,
            accessRestriction: { users: [ 'foobar' ] },
            restoreConfig: null,
            oldConfig: null,
            updateConfig: null,
            memoryLimit: 0,
            xFrameOptions: 'SAMEORIGIN',
            sso: true,
            debugMode: null,
            robotsTxt: null,
            enableBackup: true
        };

        before(function (done) {
            domaindb.add(DOMAIN_0.domain, { zoneName: DOMAIN_0.zoneName, provider: DOMAIN_0.provider, config: DOMAIN_0.config, tlsConfig: DOMAIN_0.tlsConfig }, done);
        });

        after(function (done) {
            database._clear(done);
        });

        it('add fails due to missing arguments', function () {
            expect(function () { appdb.add(APP_0.id, APP_0.manifest, APP_0.installationState, function () {}); }).to.throwError();
            expect(function () { appdb.add(APP_0.id, function () {}); }).to.throwError();
        });

        it('exists returns false', function (done) {
            appdb.exists(APP_0.id, function (error, exists) {
                expect(error).to.be(null);
                expect(exists).to.be(false);
                done();
            });
        });

        it('add succeeds', function (done) {
            appdb.add(APP_0.id, APP_0.appStoreId, APP_0.manifest, APP_0.location, APP_0.domain, APP_0.portBindings, APP_0, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('exists succeeds', function (done) {
            appdb.exists(APP_0.id, function (error, exists) {
                expect(error).to.be(null);
                expect(exists).to.be(true);
                done();
            });
        });

        it('getPortBindings succeeds', function (done) {
            appdb.getPortBindings(APP_0.id, function (error, bindings) {
                expect(error).to.be(null);
                expect(bindings).to.be.an(Object);
                expect(bindings).to.be.eql({ port: '5678' });
                done();
            });
        });

        it('add of same app fails', function (done) {
            appdb.add(APP_0.id, APP_0.appStoreId, APP_0.manifest, APP_0.location, APP_0.domain, [], APP_0, function (error) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.ALREADY_EXISTS);
                done();
            });
        });

        it('get succeeds', function (done) {
            appdb.get(APP_0.id, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.be.an('object');
                expect(_.omit(result, ['creationTime', 'updateTime'])).to.be.eql(APP_0);
                done();
            });
        });

        it('get of nonexisting code fails', function (done) {
            appdb.get(APP_1.id, function (error, result) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                expect(result).to.not.be.ok();
                done();
            });
        });

        it('update succeeds', function (done) {
            APP_0.installationState = 'some-other-status';
            APP_0.location = 'some-other-location';
            APP_0.manifest.version = '0.2';
            APP_0.accessRestriction = '';
            APP_0.httpPort = 1337;
            APP_0.memoryLimit = 1337;

            var data = {
                installationState: APP_0.installationState,
                location: APP_0.location,
                manifest: APP_0.manifest,
                accessRestriction: APP_0.accessRestriction,
                httpPort: APP_0.httpPort,
                memoryLimit: APP_0.memoryLimit
            };

            appdb.update(APP_0.id, data, function (error) {
                expect(error).to.be(null);

                appdb.get(APP_0.id, function (error, result) {
                    expect(error).to.be(null);
                    expect(result).to.be.an('object');
                    expect(_.omit(result, ['creationTime', 'updateTime'])).to.be.eql(APP_0);
                    done();
                });
            });
        });

        it('getByHttpPort succeeds', function (done) {
            appdb.getByHttpPort(APP_0.httpPort, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.be.an('object');
                expect(_.omit(result, ['creationTime', 'updateTime'])).to.be.eql(APP_0);
                done();
            });
        });

        it('update of nonexisting app fails', function (done) {
            appdb.update(APP_1.id, { installationState: APP_1.installationState, location: APP_1.location }, function (error) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                done();
            });
        });

        it('add second app succeeds', function (done) {
            appdb.add(APP_1.id, APP_1.appStoreId, APP_1.manifest, APP_1.location, APP_1.domain, [], APP_1, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('getAll succeeds', function (done) {
            appdb.getAll(function (error, result) {
                expect(error).to.be(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.be(2);
                expect(_.omit(result[0], ['creationTime', 'updateTime'])).to.be.eql(APP_0);
                expect(_.omit(result[1], ['creationTime', 'updateTime'])).to.be.eql(APP_1);
                done();
            });
        });

        it('getAppStoreIds succeeds', function (done) {
            appdb.getAppStoreIds(function (error, results) {
                expect(error).to.be(null);
                expect(results).to.be.an(Array);
                expect(results.length).to.be(2);
                expect(results[0].appStoreId).to.equal(APP_0.appStoreId);
                expect(results[1].appStoreId).to.equal(APP_1.appStoreId);
                done();
            });
        });

        it('delete succeeds', function (done) {
            appdb.del(APP_0.id, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('getPortBindings should be empty', function (done) {
            appdb.getPortBindings(APP_0.id, function (error, bindings) {
                expect(error).to.be(null);
                expect(bindings).to.be.an(Object);
                expect(bindings).to.be.eql({ });
                done();
            });
        });

        it('cannot delete previously delete record', function (done) {
            appdb.del(APP_0.id, function (error) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                done();
            });
        });

        it('cannot set app as healthy because app is not installed', function (done) {
            appdb.setHealth(APP_1.id, appdb.HEALTH_HEALTHY, function (error) {
                expect(error).to.be.ok();
                done();
            });
        });

        it('cannot set app as healthy because app has pending run state', function (done) {
            appdb.update(APP_1.id, { runState: appdb.RSTATE_PENDING_STOP, installationState: appdb.ISTATE_INSTALLED }, function (error) {
                expect(error).to.be(null);

                appdb.setHealth(APP_1.id, appdb.HEALTH_HEALTHY, function (error) {
                    expect(error).to.be.ok();
                    done();
                });
            });
        });

        it('cannot set app as healthy because app has null run state', function (done) {
            appdb.update(APP_1.id, { runState: null, installationState: appdb.ISTATE_INSTALLED }, function (error) {
                expect(error).to.be(null);

                appdb.setHealth(APP_1.id, appdb.HEALTH_HEALTHY, function (error) {
                    expect(error).to.be.ok();
                    done();
                });
            });
        });

        it('can set app as healthy when installed and no pending runState', function (done) {
            appdb.update(APP_1.id, { runState: appdb.RSTATE_RUNNING, installationState: appdb.ISTATE_INSTALLED }, function (error) {
                expect(error).to.be(null);

                appdb.setHealth(APP_1.id, appdb.HEALTH_HEALTHY, function (error) {
                    expect(error).to.be(null);
                    appdb.get(APP_1.id, function (error, app) {
                        expect(error).to.be(null);
                        expect(app.health).to.be(appdb.HEALTH_HEALTHY);
                        done();
                    });
                });
            });
        });

        it('cannot set health of unknown app', function (done) {
            appdb.setHealth('randomId', appdb.HEALTH_HEALTHY, function (error) {
                expect(error).to.be.ok();
                done();
            });
        });

        it('return empty addon config array for invalid app', function (done) {
            appdb.getAddonConfigByAppId('randomid', function (error, results) {
                expect(error).to.be(null);
                expect(results).to.eql([ ]);
                done();
            });
        });

        it('setAddonConfig succeeds', function (done) {
            appdb.setAddonConfig(APP_1.id, 'addonid1', [ { name: 'ENV1', value: 'env' }, { name: 'ENV2', value: 'env2' } ], function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('setAddonConfig succeeds', function (done) {
            appdb.setAddonConfig(APP_1.id, 'addonid2', [ { name: 'ENV3', value: 'env' } ], function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('getAddonConfig succeeds', function (done) {
            appdb.getAddonConfig(APP_1.id, 'addonid1', function (error, results) {
                expect(error).to.be(null);
                expect(results).to.eql([ { name: 'ENV1', value: 'env' }, { name: 'ENV2', value: 'env2' } ]);
                done();
            });
        });

        it('getAddonConfigByAppId succeeds', function (done) {
            appdb.getAddonConfigByAppId(APP_1.id, function (error, results) {
                expect(error).to.be(null);
                expect(results).to.eql([ { name: 'ENV1', value: 'env' }, { name: 'ENV2', value: 'env2' }, { name: 'ENV3', value: 'env' } ]);
                done();
            });
        });

        it('getAddonConfigByName succeeds', function (done) {
            appdb.getAddonConfigByName(APP_1.id, 'addonid1', 'ENV2', function (error, value) {
                expect(error).to.be(null);
                expect(value).to.be('env2');
                done();
            });
        });

        it('getAddonConfigByName of unknown value succeeds', function (done) {
            appdb.getAddonConfigByName(APP_1.id, 'addonid1', 'NOPE', function (error, value) {
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                done();
            });
        });

        it('unsetAddonConfig succeeds', function (done) {
            appdb.unsetAddonConfig(APP_1.id, 'addonid1', function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('unsetAddonConfig did remove configs', function (done) {
            appdb.getAddonConfigByAppId(APP_1.id, function (error, results) {
                expect(error).to.be(null);
                expect(results).to.eql([ { name: 'ENV3', value: 'env' }]);
                done();
            });
        });

        it('unsetAddonConfigByAppId succeeds', function (done) {
            appdb.unsetAddonConfigByAppId(APP_1.id, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('unsetAddonConfigByAppId did remove configs', function (done) {
            appdb.getAddonConfigByAppId(APP_1.id, function (error, results) {
                expect(error).to.be(null);
                expect(results).to.eql([ ]);
                done();
            });
        });
    });

    describe('client', function () {
        var CLIENT_0 = {
            id: 'cid-0',
            appId: 'someappid_0',
            type: 'typeisastring',
            clientSecret: 'secret-0',
            redirectURI: 'http://foo.bar',
            scope: '*'

        };
        var CLIENT_1 = {
            id: 'cid-1',
            appId: 'someappid_1',
            type: 'typeisastring',
            clientSecret: 'secret-',
            redirectURI: 'http://foo.bar',
            scope: '*'
        };

        it('add succeeds', function (done) {
            clientdb.add(CLIENT_0.id, CLIENT_0.appId, CLIENT_0.type, CLIENT_0.clientSecret, CLIENT_0.redirectURI, CLIENT_0.scope, function (error) {
                expect(error).to.be(null);

                clientdb.add(CLIENT_1.id, CLIENT_1.appId, CLIENT_0.type, CLIENT_1.clientSecret, CLIENT_1.redirectURI, CLIENT_1.scope, function (error) {
                    expect(error).to.be(null);
                    done();
                });
            });
        });

        it('add same client id fails', function (done) {
            clientdb.add(CLIENT_0.id, CLIENT_0.appId, CLIENT_0.type, CLIENT_0.clientSecret, CLIENT_0.redirectURI, CLIENT_0.scope, function (error) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.equal(DatabaseError.ALREADY_EXISTS);
                done();
            });
        });

        it('get succeeds', function (done) {
            clientdb.get(CLIENT_0.id, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.eql(CLIENT_0);
                done();
            });
        });

        it('getByAppId succeeds', function (done) {
            clientdb.getByAppId(CLIENT_0.appId, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.eql(CLIENT_0);
                done();
            });
        });

        it('getByAppIdAndType succeeds', function (done) {
            clientdb.getByAppIdAndType(CLIENT_0.appId, CLIENT_0.type, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.eql(CLIENT_0);
                done();
            });
        });

        it('getByAppId fails for unknown client id', function (done) {
            clientdb.getByAppId(CLIENT_0.appId + CLIENT_0.appId, function (error, result) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.equal(DatabaseError.NOT_FOUND);
                expect(result).to.not.be.ok();
                done();
            });
        });

        it('getAll succeeds', function (done) {
            clientdb.getAll(function (error, result) {
                expect(error).to.be(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.equal(5); // three built-in clients
                expect(result[3]).to.eql(CLIENT_0);
                expect(result[4]).to.eql(CLIENT_1);
                done();
            });
        });

        it('delByAppIdAndType succeeds', function (done) {
            clientdb.delByAppIdAndType(CLIENT_1.appId, CLIENT_1.type, function (error) {
                expect(error).to.be(null);

                clientdb.getByAppIdAndType(CLIENT_1.appId, CLIENT_1.type, function (error, result) {
                    expect(error).to.be.a(DatabaseError);
                    expect(error.reason).to.equal(DatabaseError.NOT_FOUND);
                    expect(result).to.not.be.ok();
                    done();
                });
            });
        });

        it('delByAppId succeeds', function (done) {
            clientdb.delByAppId(CLIENT_0.appId, function (error) {
                expect(error).to.be(null);

                clientdb.getByAppId(CLIENT_0.appId, function (error, result) {
                    expect(error).to.be.a(DatabaseError);
                    expect(error.reason).to.equal(DatabaseError.NOT_FOUND);
                    expect(result).to.not.be.ok();
                    done();
                });
            });
        });
    });

    describe('settings', function () {
        it('can set value', function (done) {
            settingsdb.set('somekey', 'somevalue', function (error) {
                expect(error).to.be(null);
                done();
            });
        });
        it('can get the set value', function (done) {
            settingsdb.get('somekey', function (error, value) {
                expect(error).to.be(null);
                expect(value).to.be('somevalue');
                done();
            });
        });
        it('can get all values', function (done) {
            settingsdb.getAll(function (error, result) {
                expect(error).to.be(null);
                expect(result).to.be.an(Array);
                expect(result[0].name).to.be('somekey');
                expect(result[0].value).to.be('somevalue');
                expect(result.length).to.be(1); // the value set above
                done();
            });
        });
        it('can update a value', function (done) {
            settingsdb.set('somekey', 'someothervalue', function (error) {
                expect(error).to.be(null);
                done();
            });
        });
        it('can get updated value', function (done) {
            settingsdb.get('somekey', function (error, value) {
                expect(error).to.be(null);
                expect(value).to.be('someothervalue');
                done();
            });
        });

    });

    describe('backup', function () {

        it('add succeeds', function (done) {
            var backup = {
                id: 'backup-box',
                version: '1.0.0',
                type: backupdb.BACKUP_TYPE_BOX,
                dependsOn: [ 'dep1' ],
                manifest: null,
                format: 'tgz'
            };

            backupdb.add(backup, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('get succeeds', function (done) {
            backupdb.get('backup-box', function (error, result) {
                expect(error).to.be(null);
                expect(result.version).to.be('1.0.0');
                expect(result.type).to.be(backupdb.BACKUP_TYPE_BOX);
                expect(result.creationTime).to.be.a(Date);
                expect(result.dependsOn).to.eql(['dep1']);
                expect(result.manifest).to.eql(null);
                done();
            });
        });

        it('get of unknown id fails', function (done) {
            backupdb.get('somerandom', function (error, result) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                expect(result).to.not.be.ok();
                done();
            });
        });

        it('getByTypePaged succeeds', function (done) {
            backupdb.getByTypePaged(backupdb.BACKUP_TYPE_BOX, 1, 5, function (error, results) {
                expect(error).to.be(null);
                expect(results).to.be.an(Array);
                expect(results.length).to.be(1);

                expect(results[0].id).to.be('backup-box');
                expect(results[0].version).to.be('1.0.0');
                expect(results[0].dependsOn).to.eql(['dep1']);
                expect(results[0].manifest).to.eql(null);

                done();
            });
        });

        it('delete succeeds', function (done) {
            backupdb.del('backup-box', function (error, result) {
                expect(error).to.be(null);
                expect(result).to.not.be.ok();

                backupdb.get('backup-box', function (error, result) {
                    expect(error).to.be.a(DatabaseError);
                    expect(error.reason).to.equal(DatabaseError.NOT_FOUND);
                    expect(result).to.not.be.ok();
                    done();
                });
            });
        });

        it('add app succeeds', function (done) {
            var backup = {
                id: 'app_appid_123',
                version: '1.0.0',
                type: backupdb.BACKUP_TYPE_APP,
                dependsOn: [ ],
                manifest: { foo: 'bar' },
                format: 'tgz'
            };

            backupdb.add(backup, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('get succeeds', function (done) {
            backupdb.get('app_appid_123', function (error, result) {
                expect(error).to.be(null);
                expect(result.version).to.be('1.0.0');
                expect(result.type).to.be(backupdb.BACKUP_TYPE_APP);
                expect(result.creationTime).to.be.a(Date);
                expect(result.dependsOn).to.eql([]);
                expect(result.manifest).to.eql({ foo: 'bar' });
                done();
            });
        });

        it('getByAppIdPaged succeeds', function (done) {
            backupdb.getByAppIdPaged(1, 5, 'appid', function (error, results) {
                expect(error).to.be(null);
                expect(results).to.be.an(Array);
                expect(results.length).to.be(1);

                expect(results[0].id).to.be('app_appid_123');
                expect(results[0].version).to.be('1.0.0');
                expect(results[0].dependsOn).to.eql([]);
                expect(results[0].manifest).to.eql({ foo: 'bar' });

                done();
            });
        });

        it('delete succeeds', function (done) {
            backupdb.del('app_appid_123', function (error, result) {
                expect(error).to.be(null);
                expect(result).to.not.be.ok();

                backupdb.get('app_appid_123', function (error, result) {
                    expect(error).to.be.a(DatabaseError);
                    expect(error.reason).to.equal(DatabaseError.NOT_FOUND);
                    expect(result).to.not.be.ok();
                    done();
                });
            });
        });

    });

    describe('eventlog', function () {

        it('add succeeds', function (done) {
            eventlogdb.add('someid', 'some.event', { ip: '1.2.3.4' }, { appId: 'thatapp' }, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('get succeeds', function (done) {
            eventlogdb.get('someid', function (error, result) {
                expect(error).to.be(null);
                expect(result.id).to.be('someid');
                expect(result.action).to.be('some.event');
                expect(result.creationTime).to.be.a(Date);

                expect(result.source).to.be.eql({ ip: '1.2.3.4' });
                expect(result.data).to.be.eql({ appId: 'thatapp' });

                done();
            });
        });

        it('get of unknown id fails', function (done) {
            eventlogdb.get('notfoundid', function (error, result) {
                expect(error).to.be.a(DatabaseError);
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                expect(result).to.not.be.ok();
                done();
            });
        });

        it('getAllPaged succeeds', function (done) {
            eventlogdb.getAllPaged([], null, 1, 1, function (error, results) {
                expect(error).to.be(null);
                expect(results).to.be.an(Array);
                expect(results.length).to.be(1);

                expect(results[0].id).to.be('someid');
                expect(results[0].action).to.be('some.event');
                expect(results[0].source).to.be.eql({ ip: '1.2.3.4' });
                expect(results[0].data).to.be.eql({ appId: 'thatapp' });

                done();
            });
        });

        it('getAllPaged succeeds with source search', function (done) {
            eventlogdb.getAllPaged([], '1.2.3.4', 1, 1, function (error, results) {
                expect(error).to.be(null);
                expect(results).to.be.an(Array);
                expect(results.length).to.be(1);

                expect(results[0].id).to.be('someid');
                expect(results[0].action).to.be('some.event');
                expect(results[0].source).to.be.eql({ ip: '1.2.3.4' });
                expect(results[0].data).to.be.eql({ appId: 'thatapp' });

                done();
            });
        });

        it('getAllPaged succeeds with data search', function (done) {
            eventlogdb.getAllPaged([], 'thatapp', 1, 1, function (error, results) {
                expect(error).to.be(null);
                expect(results).to.be.an(Array);
                expect(results.length).to.be(1);

                expect(results[0].id).to.be('someid');
                expect(results[0].action).to.be('some.event');
                expect(results[0].source).to.be.eql({ ip: '1.2.3.4' });
                expect(results[0].data).to.be.eql({ appId: 'thatapp' });

                done();
            });
        });

        it('delByCreationTime succeeds', function (done) {
            async.each([ 'persistent.event', 'transient.event', 'anothertransient.event', 'anotherpersistent.event' ], function (e, callback) {
                eventlogdb.add('someid' + Math.random(), e, { ip: '1.2.3.4' }, { appId: 'thatapp' }, callback);
            }, function (error) {
                expect(error).to.be(null);

                eventlogdb.delByCreationTime(new Date(), function (error) {
                    expect(error).to.be(null);

                    eventlogdb.getAllPaged([], null, 1, 100, function (error, results) {
                        expect(error).to.be(null);
                        expect(results.length).to.be(0);

                        done();
                    });
                });
            });
        });
    });

    describe('groups', function () {
        before(function (done) {
            config._reset();
            config.setFqdn(TEST_DOMAIN.domain);

            async.series([
                database.initialize,
                database._clear,
                userdb.add.bind(null, USER_0.id, USER_0),
                userdb.add.bind(null, USER_1.id, USER_1),
                userdb.add.bind(null, USER_2.id, USER_2)
            ], done);
        });

        var GROUP_ID_1 = 'foundersid';

        it('can create a group', function (done) {
            groupdb.add(GROUP_ID_1, 'founders', function (error, result) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can get existing group', function (done) {
            groupdb.get(GROUP_ID_1, function (error, result) {
                expect(error).to.be(null);
                expect(result.name).to.be('founders');
                done();
            });
        });

        it('can add member to the group', function (done) {
            groupdb.addMember(GROUP_ID_1, USER_0.id, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('cannot add invalid user to group', function (done) {
            groupdb.addMember(GROUP_ID_1, 'random', function (error) {
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                done();
            });
        });

        it('can set members', function (done) {
            groupdb.setMembers(GROUP_ID_1, [ USER_1.id, USER_2.id ], function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can list users of group', function (done) {
            groupdb.getMembers(GROUP_ID_1, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.eql([ USER_1.id, USER_2.id ]);
                done();
            });
        });

        it('cannot delete non-existent member', function (done) {
            groupdb.removeMember(GROUP_ID_1, 'random', function (error) {
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                done();
            });
        });

        it('can remove existing member', function (done) {
            groupdb.removeMember(GROUP_ID_1, USER_1.id, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can getWithMembers', function (done) {
            groupdb.getWithMembers(GROUP_ID_1, function (error, result) {
                expect(error).to.be(null);
                expect(result.name).to.be('founders');
                expect(result.userIds).to.eql([ USER_2.id ]);
                done();
            });
        });

        it('can getAll', function (done) {
            groupdb.getAll(function (error, result) {
                expect(error).to.be(null);
                expect(result.length).to.be(2); // admin!
                expect(result[0].name).to.be('admin');
                expect(result[1].name).to.be('founders');
                done();
            });
        });

        it('can getAllWithMembers', function (done) {
            groupdb.getAllWithMembers(function (error, result) {
                expect(error).to.be(null);
                expect(result.length).to.be(2); // admin!
                expect(result[0].name).to.be('admin');
                expect(result[0].userIds).to.eql([ ]);

                expect(result[1].name).to.be('founders');
                expect(result[1].userIds).to.eql([ USER_2.id ]);

                done();
            });
        });

        it('can set groups', function (done) {
            groupdb.setGroups(USER_0.id, [ 'admin', GROUP_ID_1 ], function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can get groups', function (done) {
            groupdb.getGroups(USER_0.id, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.eql([ 'admin', GROUP_ID_1 ]);
                done();
            });
        });
    });

    describe('importFromFile', function () {
        before(function (done) {
            config._reset();
            config.setFqdn(TEST_DOMAIN.domain);

            async.series([
                database.initialize,
                database._clear
            ], done);
        });

        it('cannot import from non-existent file', function (done) {
            database.importFromFile('/does/not/exist', function (error) {
                expect(error).to.be.ok();
                done();
            });
        });

        it('can export to file', function (done) {
            database.exportToFile('/tmp/box.mysqldump', function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can import from file', function (done) {
            database.importFromFile('/tmp/box.mysqldump', function (error) {
                expect(error).to.be(null);
                done();
            });
        });

    });

    describe('mailboxes', function () {
        before(function (done) {
            async.series([
                domaindb.add.bind(null, DOMAIN_0.domain, { zoneName: DOMAIN_0.zoneName, provider: DOMAIN_0.provider, config: DOMAIN_0.config, tlsConfig: DOMAIN_0.tlsConfig }),
                maildb.add.bind(null, DOMAIN_0.domain)
            ], done);
        });

        after(function (done) {
            database._clear(done);
        });

        it('add user mailbox succeeds', function (done) {
            mailboxdb.add('girish', DOMAIN_0.domain, 'uid-0', mailboxdb.TYPE_USER, function (error, mailbox) {
                expect(error).to.be(null);
                done();
            });
        });

        it('cannot add dup entry', function (done) {
            mailboxdb.add('girish', DOMAIN_0.domain, 'uid-1', mailboxdb.TYPE_APP, function (error, mailbox) {
                expect(error.reason).to.be(DatabaseError.ALREADY_EXISTS);
                done();
            });
        });

        it('add app mailbox succeeds', function (done) {
            mailboxdb.add('support', DOMAIN_0.domain, 'osticket', mailboxdb.TYPE_APP, function (error, mailbox) {
                expect(error).to.be(null);
                done();
            });
        });

        it('get succeeds', function (done) {
            mailboxdb.getMailbox('support', DOMAIN_0.domain, function (error, mailbox) {
                expect(error).to.be(null);
                expect(mailbox.name).to.equal('support');
                expect(mailbox.ownerId).to.equal('osticket');
                expect(mailbox.domain).to.equal(DOMAIN_0.domain);
                expect(mailbox.creationTime).to.be.a(Date);

                done();
            });
        });

        it('list mailboxes succeeds', function (done) {
            mailboxdb.listMailboxes(DOMAIN_0.domain, function (error, mailboxes) {
                expect(error).to.be(null);
                expect(mailboxes.length).to.be(2);
                expect(mailboxes[0].name).to.be('girish');
                expect(mailboxes[0].ownerType).to.be(mailboxdb.TYPE_USER);
                expect(mailboxes[1].name).to.be('support');

                done();
            });
        });

        it('can set alias', function (done) {
            mailboxdb.setAliasesForName('support', DOMAIN_0.domain, [ 'support2', 'help' ], function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can get aliases of name', function (done) {
            mailboxdb.getAliasesForName('support', DOMAIN_0.domain, function (error, results) {
                expect(error).to.be(null);
                expect(results.length).to.be(2);
                expect(results[0]).to.be('help');
                expect(results[1]).to.be('support2');
                done();
            });
        });

        it('can get alias', function (done) {
            mailboxdb.getAlias('support2', DOMAIN_0.domain, function (error, result) {
                expect(error).to.be(null);
                expect(result.name).to.be('support2');
                expect(result.aliasTarget).to.be('support');
                done();
            });
        });

        it('can list aliases', function (done) {
            mailboxdb.listAliases(DOMAIN_0.domain, function (error, results) {
                expect(error).to.be(null);
                expect(results.length).to.be(2);
                expect(results[0].name).to.be('help');
                expect(results[0].aliasTarget).to.be('support');
                expect(results[1].name).to.be('support2');
                done();
            });
        });

        it('can get by owner id', function (done) {
            mailboxdb.getByOwnerId('osticket', function (error, results) {
                expect(error).to.be(null);
                expect(results.length).to.be(3);
                expect(results[0].name).to.be('help');
                expect(results[1].name).to.be('support');
                expect(results[2].name).to.be('support2');
                done();
            });
        });

        it('cannot get non-existing group', function (done) {
            mailboxdb.getGroup('random', DOMAIN_0.domain, function (error) {
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                done();
            });
        });

        it('can change name', function (done) {
            mailboxdb.updateName('support', DOMAIN_0.domain, 'support3', DOMAIN_0.domain, function (error) {
                expect(error).to.be(null);

                mailboxdb.updateName('support3', DOMAIN_0.domain, 'support', DOMAIN_0.domain, done);
            });
        });

        it('cannot change name to existing one', function (done) {
            mailboxdb.updateName('support', DOMAIN_0.domain, 'support2', DOMAIN_0.domain, function (error) {
                expect(error).to.be.ok();
                expect(error.reason).to.eql(DatabaseError.ALREADY_EXISTS);

                done();
            });
        });

        it('unset aliases', function (done) {
            mailboxdb.setAliasesForName('support', DOMAIN_0.domain, [], function (error) {
                expect(error).to.be(null);

                mailboxdb.getAliasesForName('support', DOMAIN_0.domain, function (error, results) {
                    expect(error).to.be(null);
                    expect(results.length).to.be(0);
                    done();
                });
            });
        });

        it('del succeeds', function (done) {
            mailboxdb.del('girish', DOMAIN_0.domain, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('del by ownerId succeeds', function (done) {
            mailboxdb.delByOwnerId('osticket', function (error) {
                expect(error).to.be(null);

                mailboxdb.getByOwnerId('osticket', function (error, results) {
                    expect(error).to.be.ok();
                    expect(error.reason).to.be(DatabaseError.NOT_FOUND);
                    done();
                });
            });
        });
    });

    describe('mail', function () {
        const MAIL_DOMAIN_0 = {
            domain: DOMAIN_0.domain,
            enabled: false,
            relay: { provider: 'cloudron-smtp' },
            catchAll: [ ],
            mailFromValidation: true
        };

        before(function (done) {
            domaindb.add(DOMAIN_0.domain, { zoneName: DOMAIN_0.zoneName, provider: DOMAIN_0.provider, config: DOMAIN_0.config, tlsConfig: DOMAIN_0.tlsConfig }, done);
        });

        after(function (done) {
            database._clear(done);
        });

        it('cannot add non-existing domain', function (done) {
            maildb.add(MAIL_DOMAIN_0.domain + 'nope', function (error) {
                expect(error).to.be.ok();
                expect(error.reason).to.be(DatabaseError.NOT_FOUND);

                done();
            });
        });

        it('can add domain', function (done) {
            maildb.add(MAIL_DOMAIN_0.domain, function (error) {
                expect(error).to.equal(null);

                done();
            });
        });

        it('can get all domains', function (done) {
            maildb.getAll(function (error, result) {
                expect(error).to.equal(null);
                expect(result).to.be.an(Array);
                expect(result[0]).to.be.an('object');
                expect(result[0].domain).to.eql(MAIL_DOMAIN_0.domain);

                done();
            });
        });

        it('can get domain', function (done) {
            maildb.get(MAIL_DOMAIN_0.domain, function (error, result) {
                expect(error).to.equal(null);
                expect(result).to.be.an('object');
                expect(result).to.eql(MAIL_DOMAIN_0);

                done();
            });
        });
    });
});
