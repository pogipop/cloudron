/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var appdb = require('../appdb.js'),
    apps = require('../apps.js'),
    async = require('async'),
    config = require('../config.js'),
    constants = require('../constants.js'),
    database = require('../database.js'),
    domains = require('../domains.js'),
    expect = require('expect.js'),
    mail = require('../mail.js'),
    mailer = require('../mailer.js'),
    nock = require('nock'),
    paths = require('../paths.js'),
    safe = require('safetydance'),
    semver = require('semver'),
    settings = require('../settings.js'),
    settingsdb = require('../settingsdb.js'),
    updatechecker = require('../updatechecker.js'),
    users = require('../users.js');

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
    config: {},
    provider: 'manual',
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

var AUDIT_SOURCE = {
    ip: '1.2.3.4'
};

const UPDATE_VERSION = semver.inc(config.version(), 'major');

function checkMails(number, done) {
    // mails are enqueued async
    setTimeout(function () {
        expect(mailer._getMailQueue().length).to.equal(number);
        mailer._clearMailQueue();
        done();
    }, 500);
}

function cleanup(done) {
    mailer._clearMailQueue();
    safe.fs.unlinkSync(paths.UPDATE_CHECKER_FILE);

    async.series([
        settings.uninitialize,
        database._clear,
        database.uninitialize
    ], done);
}

describe('updatechecker - box - manual (email)', function () {
    before(function (done) {
        config._reset();
        config.setFqdn(DOMAIN_0.domain);
        config.set('apiServerOrigin', 'http://localhost:4444');
        config.set('provider', 'notcaas');
        safe.fs.unlinkSync(paths.UPDATE_CHECKER_FILE);

        async.series([
            database.initialize,
            database._clear,
            settings.initialize,
            domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig),
            mail.addDomain.bind(null, DOMAIN_0.domain),
            users.createOwner.bind(null, USER_0.username, USER_0.password, USER_0.email, USER_0.displayName, AUDIT_SOURCE),
            settings.setBoxAutoupdatePattern.bind(null, constants.AUTOUPDATE_PATTERN_NEVER),
            settingsdb.set.bind(null, settings.APPSTORE_CONFIG_KEY, JSON.stringify({ userId: 'uid', cloudronId: 'cid', token: 'token' })),
            mailer._clearMailQueue
        ], done);
    });

    after(cleanup);

    it('no updates', function (done) {
        nock.cleanAll();

        var scope = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/boxupdate')
            .query({ boxVersion: config.version(), accessToken: 'token' })
            .reply(204, { } );

        updatechecker.checkBoxUpdates(function (error) {
            expect(!error).to.be.ok();
            expect(updatechecker.getUpdateInfo().box).to.be(null);
            expect(scope.isDone()).to.be.ok();

            checkMails(0, done);
        });
    });

    it('new version', function (done) {
        nock.cleanAll();

        var scope = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/boxupdate')
            .query({ boxVersion: config.version(), accessToken: 'token' })
            .reply(200, { version: UPDATE_VERSION, changelog: [''], sourceTarballUrl: 'box.tar.gz' } );

        var scope2 = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/subscription')
            .query({ accessToken: 'token' })
            .reply(200, { subscription: { plan: { id: 'pro' } } } );

        updatechecker.checkBoxUpdates(function (error) {
            expect(!error).to.be.ok();
            expect(updatechecker.getUpdateInfo().box.version).to.be(UPDATE_VERSION);
            expect(updatechecker.getUpdateInfo().box.sourceTarballUrl).to.be('box.tar.gz');
            expect(scope.isDone()).to.be.ok();
            expect(scope2.isDone()).to.be.ok();

            checkMails(1, done);
        });
    });

    it('bad response offers nothing', function (done) {
        nock.cleanAll();

        var scope = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/boxupdate')
            .query({ boxVersion: config.version(), accessToken: 'token' })
            .reply(404, { version: '2.0.0-pre.0', changelog: [''], sourceTarballUrl: 'box-pre.tar.gz' } );

        updatechecker.checkBoxUpdates(function (error) {
            expect(error).to.be.ok();
            expect(updatechecker.getUpdateInfo().box).to.be(null);
            expect(scope.isDone()).to.be.ok();

            checkMails(0, done);
        });
    });
});

describe('updatechecker - box - automatic (no email)', function () {
    before(function (done) {
        config.setFqdn(DOMAIN_0.domain);
        config.set('apiServerOrigin', 'http://localhost:4444');
        config.set('provider', 'notcaas');

        async.series([
            database.initialize,
            settings.initialize,
            domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig),
            mail.addDomain.bind(null, DOMAIN_0.domain),
            mailer._clearMailQueue,
            users.createOwner.bind(null, USER_0.username, USER_0.password, USER_0.email, USER_0.displayName, AUDIT_SOURCE),
            settingsdb.set.bind(null, settings.APPSTORE_CONFIG_KEY, JSON.stringify({ userId: 'uid', cloudronId: 'cid', token: 'token' }))
        ], done);
    });

    after(cleanup);

    it('new version', function (done) {
        nock.cleanAll();

        var scope = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/boxupdate')
            .query({ boxVersion: config.version(), accessToken: 'token' })
            .reply(200, { version: UPDATE_VERSION, sourceTarballUrl: 'box.tar.gz' } );

        var scope2 = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/subscription')
            .query({ accessToken: 'token' })
            .reply(200, { subscription: { plan: { id: 'pro' } } } );

        updatechecker.checkBoxUpdates(function (error) {
            expect(!error).to.be.ok();
            expect(updatechecker.getUpdateInfo().box.version).to.be(UPDATE_VERSION);
            expect(scope.isDone()).to.be.ok();
            expect(scope2.isDone()).to.be.ok();

            checkMails(0, done);
        });
    });
});

describe('updatechecker - box - automatic free (email)', function () {
    before(function (done) {
        config.setFqdn(DOMAIN_0.domain);
        config.set('version', '1.0.0');
        config.set('apiServerOrigin', 'http://localhost:4444');
        config.set('provider', 'notcaas');

        async.series([
            database.initialize,
            settings.initialize,
            domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig),
            mail.addDomain.bind(null, DOMAIN_0.domain),
            mailer._clearMailQueue,
            users.createOwner.bind(null, USER_0.username, USER_0.password, USER_0.email, USER_0.displayName, AUDIT_SOURCE),
            settingsdb.set.bind(null, settings.APPSTORE_CONFIG_KEY, JSON.stringify({ userId: 'uid', cloudronId: 'cid', token: 'token' }))
        ], done);
    });

    after(cleanup);

    it('new version', function (done) {
        nock.cleanAll();

        var scope = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/boxupdate')
            .query({ boxVersion: config.version(), accessToken: 'token' })
            .reply(200, { version: UPDATE_VERSION, changelog: [''], sourceTarballUrl: 'box.tar.gz' } );

        var scope2 = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/subscription')
            .query({ accessToken: 'token' })
            .reply(200, { subscription: { plan: { id: 'free' } } } );

        updatechecker.checkBoxUpdates(function (error) {
            expect(!error).to.be.ok();
            expect(updatechecker.getUpdateInfo().box.version).to.be(UPDATE_VERSION);
            expect(scope.isDone()).to.be.ok();
            expect(scope2.isDone()).to.be.ok();

            checkMails(1, done);
        });
    });
});

describe('updatechecker - app - manual (email)', function () {
    var APP_0 = {
        id: 'appid-0',
        appStoreId: 'io.cloudron.app',
        installationState: appdb.ISTATE_PENDING_INSTALL,
        installationProgress: null,
        runState: null,
        location: 'some-location-0',
        domain: DOMAIN_0.domain,
        manifest: {
            version: '1.0.0', dockerImage: 'docker/app0', healthCheckPath: '/', httpPort: 80, title: 'app0',
            tcpPorts: {
                PORT: {
                    description: 'this is a port that i expose',
                    containerPort: '1234'
                }
            }
        },
        httpPort: null,
        containerId: null,
        portBindings: { PORT: 5678 },
        healthy: null,
        accessRestriction: null,
        memoryLimit: 0,
        ownerId: null
    };

    before(function (done) {
        config.setFqdn(DOMAIN_0.domain);
        config.set('version', '1.0.0');
        config.set('apiServerOrigin', 'http://localhost:4444');
        config.set('provider', 'notcaas');

        async.series([
            database.initialize,
            database._clear,
            settings.initialize,
            domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig),
            mail.addDomain.bind(null, DOMAIN_0.domain),
            mailer._clearMailQueue,
            function (next) {
                users.createOwner(USER_0.username, USER_0.password, USER_0.email, USER_0.displayName, AUDIT_SOURCE, function (error, userObject) {
                    if (error) return next(error);

                    APP_0.ownerId = userObject.id;
                    appdb.add(APP_0.id, APP_0.appStoreId, APP_0.manifest, APP_0.location, APP_0.domain, APP_0.ownerId, apps._translatePortBindings(APP_0.portBindings, APP_0.manifest), APP_0, next);
                });
            },
            settings.setAppAutoupdatePattern.bind(null, constants.AUTOUPDATE_PATTERN_NEVER),
            settingsdb.set.bind(null, settings.APPSTORE_CONFIG_KEY, JSON.stringify({ userId: 'uid', cloudronId: 'cid', token: 'token' }))
        ], done);
    });

    after(cleanup);

    it('no updates', function (done) {
        nock.cleanAll();

        var scope = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/appupdate')
            .query({ boxVersion: config.version(), accessToken: 'token', appId: APP_0.appStoreId, appVersion: APP_0.manifest.version })
            .reply(204, { } );

        updatechecker.checkAppUpdates(function (error) {
            expect(!error).to.be.ok();
            expect(updatechecker.getUpdateInfo().apps).to.eql({});
            expect(scope.isDone()).to.be.ok();

            checkMails(0, done);
        });
    });

    it('bad response', function (done) {
        nock.cleanAll();

        var scope = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/appupdate')
            .query({ boxVersion: config.version(), accessToken: 'token', appId: APP_0.appStoreId, appVersion: APP_0.manifest.version })
            .reply(500, { update: { manifest: { version: '1.0.0' } } } );

        updatechecker.checkAppUpdates(function (error) {
            expect(!error).to.be.ok();
            expect(updatechecker.getUpdateInfo().apps).to.eql({});
            expect(scope.isDone()).to.be.ok();

            checkMails(0, done);
        });
    });

    it('offers new version', function (done) {
        nock.cleanAll();

        var scope = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/appupdate')
            .query({ boxVersion: config.version(), accessToken: 'token', appId: APP_0.appStoreId, appVersion: APP_0.manifest.version })
            .reply(200, { manifest: { version: '2.0.0' } } );

        var scope2 = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/subscription')
            .query({ accessToken: 'token' })
            .reply(200, { subscription: { plan: { id: 'pro' } } } );

        updatechecker.checkAppUpdates(function (error) {
            expect(!error).to.be.ok();
            expect(updatechecker.getUpdateInfo().apps).to.eql({ 'appid-0': { manifest: { version: '2.0.0' } } });
            expect(scope.isDone()).to.be.ok();
            expect(scope2.isDone()).to.be.ok();

            checkMails(1, done);
        });
    });

    it('does not offer old version', function (done) {
        nock.cleanAll();

        updatechecker.checkAppUpdates(function (error) {
            expect(!error).to.be.ok();
            expect(updatechecker.getUpdateInfo().apps).to.eql({ });
            checkMails(0, done);
        });
    });
});

describe('updatechecker - app - automatic (no email)', function () {
    var APP_0 = {
        id: 'appid-0',
        appStoreId: 'io.cloudron.app',
        installationState: appdb.ISTATE_PENDING_INSTALL,
        installationProgress: null,
        runState: null,
        location: 'some-location-0',
        domain: DOMAIN_0.domain,
        manifest: {
            version: '1.0.0', dockerImage: 'docker/app0', healthCheckPath: '/', httpPort: 80, title: 'app0',
            tcpPorts: {
                PORT: {
                    description: 'this is a port that i expose',
                    containerPort: '1234'
                }
            }
        },
        httpPort: null,
        containerId: null,
        portBindings: { PORT: 5678 },
        healthy: null,
        accessRestriction: null,
        memoryLimit: 0,
        ownerId: null
    };

    before(function (done) {
        config.setFqdn(DOMAIN_0.domain);
        config.set('version', '1.0.0');
        config.set('apiServerOrigin', 'http://localhost:4444');
        config.set('provider', 'notcaas');

        async.series([
            database.initialize,
            database._clear,
            settings.initialize,
            domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig),
            mail.addDomain.bind(null, DOMAIN_0.domain),
            mailer._clearMailQueue,
            function (next) {
                users.createOwner(USER_0.username, USER_0.password, USER_0.email, USER_0.displayName, AUDIT_SOURCE, function (error, userObject) {
                    if (error) return next(error);

                    APP_0.ownerId = userObject.id;
                    appdb.add(APP_0.id, APP_0.appStoreId, APP_0.manifest, APP_0.location, APP_0.domain, APP_0.ownerId, apps._translatePortBindings(APP_0.portBindings, APP_0.manifest), APP_0, next);
                });
            },
            settings.setAppAutoupdatePattern.bind(null, '00 00 1,3,5,23 * * *'),
            settingsdb.set.bind(null, settings.APPSTORE_CONFIG_KEY, JSON.stringify({ userId: 'uid', cloudronId: 'cid', token: 'token' }))
        ], done);
    });

    after(cleanup);

    it('offers new version', function (done) {
        nock.cleanAll();

        var scope = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/appupdate')
            .query({ boxVersion: config.version(), accessToken: 'token', appId: APP_0.appStoreId, appVersion: APP_0.manifest.version })
            .reply(200, { manifest: { version: '2.0.0' } } );

        updatechecker.checkAppUpdates(function (error) {
            expect(!error).to.be.ok();
            expect(updatechecker.getUpdateInfo().apps).to.eql({ 'appid-0': { manifest: { version: '2.0.0' } } });
            expect(scope.isDone()).to.be.ok();

            checkMails(0, done);
        });
    });
});

describe('updatechecker - app - automatic free (email)', function () {
    var APP_0 = {
        id: 'appid-0',
        appStoreId: 'io.cloudron.app',
        installationState: appdb.ISTATE_PENDING_INSTALL,
        installationProgress: null,
        runState: null,
        location: 'some-location-0',
        domain: DOMAIN_0.domain,
        manifest: {
            version: '1.0.0', dockerImage: 'docker/app0', healthCheckPath: '/', httpPort: 80, title: 'app0',
            tcpPorts: {
                PORT: {
                    description: 'this is a port that i expose',
                    containerPort: '1234'
                }
            }
        },
        httpPort: null,
        containerId: null,
        portBindings: { PORT: 5678 },
        healthy: null,
        accessRestriction: null,
        memoryLimit: 0,
        ownerId: null
    };

    before(function (done) {
        config.setFqdn(DOMAIN_0.domain);
        config.set('version', '1.0.0');
        config.set('apiServerOrigin', 'http://localhost:4444');
        config.set('provider', 'notcaas');

        async.series([
            database.initialize,
            database._clear,
            settings.initialize,
            domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig),
            mail.addDomain.bind(null, DOMAIN_0.domain),
            mailer._clearMailQueue,
            function (next) {
                users.createOwner(USER_0.username, USER_0.password, USER_0.email, USER_0.displayName, AUDIT_SOURCE, function (error, userObject) {
                    if (error) return next(error);

                    APP_0.ownerId = userObject.id;
                    appdb.add(APP_0.id, APP_0.appStoreId, APP_0.manifest, APP_0.location, APP_0.domain, APP_0.ownerId, apps._translatePortBindings(APP_0.portBindings, APP_0.manifest), APP_0, next);
                });
            },
            settings.setAppAutoupdatePattern.bind(null, '00 00 1,3,5,23 * * *'),
            settingsdb.set.bind(null, settings.APPSTORE_CONFIG_KEY, JSON.stringify({ userId: 'uid', cloudronId: 'cid', token: 'token' }))
        ], done);
    });

    after(cleanup);

    it('offers new version', function (done) {
        nock.cleanAll();

        var scope = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/appupdate')
            .query({ boxVersion: config.version(), accessToken: 'token', appId: APP_0.appStoreId, appVersion: APP_0.manifest.version })
            .reply(200, { manifest: { version: '2.0.0' } } );

        var scope2 = nock('http://localhost:4444')
            .get('/api/v1/users/uid/cloudrons/cid/subscription')
            .query({ accessToken: 'token' })
            .reply(200, { subscription: { plan: { id: 'free' } } } );

        updatechecker.checkAppUpdates(function (error) {
            expect(!error).to.be.ok();
            expect(updatechecker.getUpdateInfo().apps).to.eql({ 'appid-0': { manifest: { version: '2.0.0' } } });
            expect(scope.isDone()).to.be.ok();
            expect(scope2.isDone()).to.be.ok();

            checkMails(1, done);
        });
    });
});
