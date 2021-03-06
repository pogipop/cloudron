/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var appdb = require('../appdb.js'),
    apps = require('../apps.js'),
    AppsError = apps.AppsError,
    async = require('async'),
    database = require('../database.js'),
    domains = require('../domains.js'),
    expect = require('expect.js'),
    groupdb = require('../groupdb.js'),
    groups = require('../groups.js'),
    hat = require('../hat.js'),
    userdb = require('../userdb.js');

let AUDIT_SOURCE = { ip: '1.2.3.4' };

describe('Apps', function () {
    var ADMIN_0 = {
        id: 'admin123',
        username: 'admin123',
        password: 'secret',
        email: 'admin@me.com',
        fallbackEmail: 'admin@me.com',
        salt: 'morton',
        createdAt: 'sometime back',
        modifiedAt: 'now',
        resetToken: hat(256),
        displayName: '',
        groupIds: [],
        admin: true
    };

    var USER_0 = {
        id: 'uuid213',
        username: 'uuid213',
        password: 'secret',
        email: 'safe@me.com',
        fallbackEmail: 'safe@me.com',
        salt: 'morton',
        createdAt: 'sometime back',
        modifiedAt: 'now',
        resetToken: hat(256),
        displayName: '',
        groupIds: [],
        admin: false
    };

    var USER_1 = {
        id: 'uuid2134',
        username: 'uuid2134',
        password: 'secret',
        email: 'safe1@me.com',
        fallbackEmail: 'safe1@me.com',
        salt: 'morton',
        createdAt: 'sometime back',
        modifiedAt: 'now',
        resetToken: hat(256),
        displayName: '',
        groupIds: [ 'somegroup' ],
        admin: false
    };

    var GROUP_0 = {
        id: 'somegroup',
        name: 'group0'
    };
    var GROUP_1 = {
        id: 'anothergroup',
        name: 'group1'
    };

    const DOMAIN_0 = {
        domain: 'example.com',
        zoneName: 'example.com',
        provider: 'manual',
        config: { },
        fallbackCertificate: null,
        tlsConfig: { provider: 'fallback' }
    };

    const DOMAIN_1 = {
        domain: 'example2.com',
        zoneName: 'example2.com',
        provider: 'manual',
        config: { },
        fallbackCertificate: null,
        tlsConfig: { provider: 'fallback' }
    };

    var APP_0 = {
        id: 'appid-0',
        appStoreId: 'appStoreId-0',
        location: 'some-location-0',
        domain: DOMAIN_0.domain,
        fqdn: 'some-location-0.' + DOMAIN_0.domain, // required for oldConfig
        manifest: {
            version: '0.1', dockerImage: 'docker/app0', healthCheckPath: '/', httpPort: 80, title: 'app0',
            tcpPorts: {
                PORT: {
                    description: 'this is a port that i expose',
                    containerPort: '1234'
                }
            }
        },
        portBindings: { PORT: 5678 },
        accessRestriction: null,
        memoryLimit: 0,
        robotsTxt: null,
        sso: false,
        env: {
            'CUSTOM_KEY': 'CUSTOM_VALUE'
        },
        dataDir: ''
    };

    var APP_1 = {
        id: 'appid-1',
        appStoreId: 'appStoreId-1',
        location: 'some-location-1',
        domain: DOMAIN_0.domain,
        fqdn: 'some-location-1.' + DOMAIN_0.domain, // required for oldConfig
        manifest: {
            version: '0.1', dockerImage: 'docker/app1', healthCheckPath: '/', httpPort: 80, title: 'app1',
            tcpPorts: {}
        },
        portBindings: {},
        accessRestriction: { users: [ 'someuser' ], groups: [ GROUP_0.id ] },
        memoryLimit: 0,
        env: {},
        dataDir: ''
    };

    var APP_2 = {
        id: 'appid-2',
        appStoreId: 'appStoreId-2',
        location: 'some-location-2',
        domain: DOMAIN_1.domain,
        fqdn: 'some-location-2.' + DOMAIN_1.domain, // required for oldConfig
        manifest: {
            version: '0.1', dockerImage: 'docker/app2', healthCheckPath: '/', httpPort: 80, title: 'app2',
            tcpPorts: {}
        },
        portBindings: {},
        accessRestriction: { users: [ 'someuser', USER_0.id ], groups: [ GROUP_1.id ] },
        memoryLimit: 0,
        robotsTxt: null,
        sso: false,
        env: {},
        dataDir: ''
    };

    before(function (done) {
        async.series([
            database.initialize,
            database._clear,
            domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE),
            domains.add.bind(null, DOMAIN_1.domain, DOMAIN_1, AUDIT_SOURCE),
            userdb.add.bind(null, ADMIN_0.id, ADMIN_0),
            userdb.add.bind(null, USER_0.id, USER_0),
            userdb.add.bind(null, USER_1.id, USER_1),
            groupdb.add.bind(null, GROUP_0.id, GROUP_0.name),
            groupdb.add.bind(null, GROUP_1.id, GROUP_1.name),
            groups.addMember.bind(null, GROUP_0.id, USER_1.id),
            appdb.add.bind(null, APP_0.id, APP_0.appStoreId, APP_0.manifest, APP_0.location, APP_0.domain, apps._translatePortBindings(APP_0.portBindings, APP_0.manifest), APP_0),
            appdb.add.bind(null, APP_1.id, APP_1.appStoreId, APP_1.manifest, APP_1.location, APP_1.domain, apps._translatePortBindings(APP_1.portBindings, APP_1.manifest), APP_1),
            appdb.add.bind(null, APP_2.id, APP_2.appStoreId, APP_2.manifest, APP_2.location, APP_2.domain, apps._translatePortBindings(APP_2.portBindings, APP_2.manifest), APP_2),
        ], done);
    });

    after(function (done) {
        async.series([
            database._clear,
            database.uninitialize
        ], done);
    });

    describe('validatePortBindings', function () {
        it('does not allow invalid host port', function () {
            expect(apps._validatePortBindings({ port: -1 }, { tcpPorts: { port: 5000 } })).to.be.an(Error);
            expect(apps._validatePortBindings({ port: 0 }, { tcpPorts: { port: 5000 } })).to.be.an(Error);
            expect(apps._validatePortBindings({ port: 'text' }, { tcpPorts: { port: 5000 } })).to.be.an(Error);
            expect(apps._validatePortBindings({ port: 65536 }, { tcpPorts: { port: 5000 } })).to.be.an(Error);
            expect(apps._validatePortBindings({ port: 470 }, { tcpPorts: { port: 5000 } })).to.be.an(Error);
        });

        it('does not allow ports not as part of manifest', function () {
            expect(apps._validatePortBindings({ port: 1567 }, { tcpPorts: { } })).to.be.an(Error);
            expect(apps._validatePortBindings({ port: 1567 }, { tcpPorts: { port3: null } })).to.be.an(Error);
        });

        it('allows valid bindings', function () {
            expect(apps._validatePortBindings({ port: 1024 }, { tcpPorts: { port: 5000 } })).to.be(null);

            expect(apps._validatePortBindings({
                port1: 4033,
                port2: 3242,
                port3: 1234
            }, { tcpPorts: { port1: null, port2: null, port3: null } })).to.be(null);
        });
    });

    describe('getters', function () {
        it('cannot get invalid app', function (done) {
            apps.get('nope', function (error) {
                expect(error).to.be.ok();
                expect(error.reason).to.be(AppsError.NOT_FOUND);
                done();
            });
        });

        it('can get valid app', function (done) {
            apps.get(APP_0.id, function (error, app) {
                expect(error).to.be(null);
                expect(app).to.be.ok();
                expect(app.iconUrl).to.be(null);
                expect(app.fqdn).to.eql(APP_0.location + '.' + DOMAIN_0.domain);
                expect(app.memoryLimit).to.eql(0);
                done();
            });
        });

        it('can getAll', function (done) {
            apps.getAll(function (error, apps) {
                expect(error).to.be(null);
                expect(apps).to.be.an(Array);
                expect(apps[0].id).to.be(APP_0.id);
                expect(apps[0].iconUrl).to.be(null);
                expect(apps[0].fqdn).to.eql(APP_0.location + '.' + DOMAIN_0.domain);
                done();
            });
        });
    });

    describe('validateAccessRestriction', function () {
        it('allows null input', function () {
            expect(apps._validateAccessRestriction(null)).to.eql(null);
        });

        it('does not allow wrong user type', function () {
            expect(apps._validateAccessRestriction({ users: {} })).to.be.an(Error);
        });

        it('allows user input', function () {
            expect(apps._validateAccessRestriction({ users: [] })).to.eql(null);
        });

        it('allows single user input', function () {
            expect(apps._validateAccessRestriction({ users: [ 'someuserid' ] })).to.eql(null);
        });

        it('allows multi user input', function () {
            expect(apps._validateAccessRestriction({ users: [ 'someuserid', 'someuserid1', 'someuserid2', 'someuserid3' ] })).to.eql(null);
        });
    });

    describe('hasAccessTo', function () {
        const someuser = { id: 'someuser', groupIds: [], admin: false };
        const adminuser = { id: 'adminuser', groupIds: [ 'groupie' ], admin: true };

        it('returns true for unrestricted access', function (done) {
            apps.hasAccessTo({ accessRestriction: null }, someuser, function (error, access) {
                expect(error).to.be(null);
                expect(access).to.be(true);
                done();
            });
        });

        it('returns true for allowed user', function (done) {
            apps.hasAccessTo({ accessRestriction: { users: [ 'someuser' ] } }, someuser, function (error, access) {
                expect(error).to.be(null);
                expect(access).to.be(true);
                done();
            });
        });

        it('returns true for allowed user with multiple allowed', function (done) {
            apps.hasAccessTo({ accessRestriction: { users: [ 'foo', 'someuser', 'anotheruser' ] } }, someuser, function (error, access) {
                expect(error).to.be(null);
                expect(access).to.be(true);
                done();
            });
        });

        it('returns false for not allowed user', function (done) {
            apps.hasAccessTo({ accessRestriction: { users: [ 'foo' ] } }, someuser, function (error, access) {
                expect(error).to.be(null);
                expect(access).to.be(false);
                done();
            });
        });

        it('returns false for not allowed user with multiple allowed', function (done) {
            apps.hasAccessTo({ accessRestriction: { users: [ 'foo', 'anotheruser' ] } }, someuser, function (error, access) {
                expect(error).to.be(null);
                expect(access).to.be(false);
                done();
            });
        });

        it('returns false for no group or user', function (done) {
            apps.hasAccessTo({ accessRestriction: { users: [ ], groups: [ ] } }, someuser, function (error, access) {
                expect(error).to.be(null);
                expect(access).to.be(false);
                done();
            });
        });

        it('returns false for invalid group or user', function (done) {
            apps.hasAccessTo({ accessRestriction: { users: [ ], groups: [ 'nop' ] } }, someuser, function (error, access) {
                expect(error).to.be(null);
                expect(access).to.be(false);
                done();
            });
        });

        it('returns true for admin user', function (done) {
            apps.hasAccessTo({ accessRestriction: { users: [ ], groups: [ 'nop' ] } }, adminuser, function (error, access) {
                expect(error).to.be(null);
                expect(access).to.be(true);
                done();
            });
        });
    });

    describe('getAllByUser', function () {
        it('succeeds for USER_0', function (done) {
            apps.getAllByUser(USER_0, function (error, result) {
                expect(error).to.equal(null);
                expect(result.length).to.equal(2);
                expect(result[0].id).to.equal(APP_0.id);
                expect(result[1].id).to.equal(APP_2.id);
                done();
            });
        });

        it('succeeds for USER_1', function (done) {
            apps.getAllByUser(USER_1, function (error, result) {
                expect(error).to.equal(null);
                expect(result.length).to.equal(2);
                expect(result[0].id).to.equal(APP_0.id);
                expect(result[1].id).to.equal(APP_1.id);
                done();
            });
        });

        it('returns all apps for admin', function (done) {
            apps.getAllByUser(ADMIN_0, function (error, result) {
                expect(error).to.equal(null);
                expect(result.length).to.equal(3);
                expect(result[0].id).to.equal(APP_0.id);
                expect(result[1].id).to.equal(APP_1.id);
                expect(result[2].id).to.equal(APP_2.id);
                done();
            });
        });
    });

    describe('configureInstalledApps', function () {
        before(function (done) {
            async.series([
                appdb.update.bind(null, APP_0.id, { installationState: appdb.ISTATE_INSTALLED }),
                appdb.update.bind(null, APP_1.id, { installationState: appdb.ISTATE_ERROR }),
                appdb.update.bind(null, APP_2.id, { installationState: appdb.ISTATE_INSTALLED })
            ], done);
        });

        it('can mark apps for reconfigure', function (done) {
            apps.configureInstalledApps(function (error) {
                expect(error).to.be(null);

                apps.getAll(function (error, apps) {
                    expect(apps[0].installationState).to.be(appdb.ISTATE_PENDING_CONFIGURE);
                    expect(apps[0].oldConfig).to.be(null);
                    expect(apps[1].installationState).to.be(appdb.ISTATE_PENDING_CONFIGURE); // erorred app can be reconfigured after restore
                    expect(apps[1].oldConfig).to.be(null);
                    expect(apps[2].installationState).to.be(appdb.ISTATE_PENDING_CONFIGURE);
                    expect(apps[2].oldConfig).to.be(null);

                    done();
                });
            });
        });
    });

    describe('restoreInstalledApps', function () {
        before(function (done) {
            async.series([
                appdb.update.bind(null, APP_0.id, { installationState: appdb.ISTATE_INSTALLED }),
                appdb.update.bind(null, APP_1.id, { installationState: appdb.ISTATE_ERROR }),
                appdb.update.bind(null, APP_2.id, { installationState: appdb.ISTATE_INSTALLED })
            ], done);
        });

        it('can mark apps for reconfigure', function (done) {
            apps.restoreInstalledApps(function (error) {
                expect(error).to.be(null);

                apps.getAll(function (error, result) {
                    expect(result[0].installationState).to.be(appdb.ISTATE_PENDING_RESTORE);
                    expect(result[0].oldConfig).to.eql(apps.getAppConfig(APP_0));
                    expect(result[1].installationState).to.be(appdb.ISTATE_PENDING_RESTORE);
                    expect(result[2].installationState).to.be(appdb.ISTATE_PENDING_RESTORE);
                    expect(result[2].oldConfig).to.eql(apps.getAppConfig(APP_2));

                    done();
                });
            });
        });
    });
});

