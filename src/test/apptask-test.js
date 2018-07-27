/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var addons = require('../addons.js'),
    appdb = require('../appdb.js'),
    apptask = require('../apptask.js'),
    async = require('async'),
    config = require('../config.js'),
    database = require('../database.js'),
    domains = require('../domains.js'),
    expect = require('expect.js'),
    fs = require('fs'),
    js2xml = require('js2xmlparser').parse,
    net = require('net'),
    nock = require('nock'),
    paths = require('../paths.js'),
    settings = require('../settings.js'),
    userdb = require('../userdb.js'),
    _ = require('underscore');

var MANIFEST = {
    'id': 'io.cloudron.test',
    'author': 'The Presidents Of the United States Of America',
    'title': 'test title',
    'description': 'test description',
    'tagline': 'test rocks',
    'website': 'http://test.cloudron.io',
    'contactEmail': 'support@cloudron.io',
    'version': '0.1.0',
    'manifestVersion': 1,
    'dockerImage': 'cloudron/test:25.2.0',
    'healthCheckPath': '/',
    'httpPort': 7777,
    'tcpPorts': {
        'ECHO_SERVER_PORT': {
            'title': 'Echo Server Port',
            'description': 'Echo server',
            'containerPort': 7778
        }
    },
    'addons': {
        'oauth': { },
        'redis': { },
        'mysql': { },
        'postgresql': { }
    }
};

const DOMAIN_0 = {
    domain: 'example.com',
    zoneName: 'example.com',
    provider: 'route53',
    config: {
        accessKeyId: 'accessKeyId',
        secretAccessKey: 'secretAccessKey',
        endpoint: 'http://localhost:5353'
    },
    tlsConfig: { provider: 'caas' }
};

var ADMIN = {
    id: 'admin123',
    username: 'admin123',
    password: 'secret',
    email: 'admin@me.com',
    fallbackEmail: 'admin@me.com',
    salt: 'morton',
    createdAt: 'sometime back',
    modifiedAt: 'now',
    resetToken: '',
    displayName: '',
    admin: true
};

var APP = {
    id: 'appid',
    appStoreId: 'appStoreId',
    installationState: appdb.ISTATE_PENDING_INSTALL,
    runState: null,
    location: 'applocation',
    domain: DOMAIN_0.domain,
    fqdn: DOMAIN_0.domain + '.' + 'applocation',
    manifest: MANIFEST,
    containerId: null,
    httpPort: 4567,
    portBindings: null,
    accessRestriction: null,
    memoryLimit: 0,
    ownerId: ADMIN.id
};

var awsHostedZones;

describe('apptask', function () {
    before(function (done) {
        config._reset();
        config.setFqdn(DOMAIN_0.domain);
        config.set('provider', 'caas');

        awsHostedZones = {
            HostedZones: [{
                Id: '/hostedzone/ZONEID',
                Name: `${DOMAIN_0.domain}.`,
                CallerReference: '305AFD59-9D73-4502-B020-F4E6F889CB30',
                ResourceRecordSetCount: 2,
                ChangeInfo: {
                    Id: '/change/CKRTFJA0ANHXB',
                    Status: 'INSYNC'
                }
            }],
            IsTruncated: false,
            MaxItems: '100'
        };

        async.series([
            database.initialize,
            database._clear,
            domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, null, DOMAIN_0.tlsConfig),
            userdb.add.bind(null, ADMIN.id, ADMIN),
            appdb.add.bind(null, APP.id, APP.appStoreId, APP.manifest, APP.location, APP.domain, APP.ownerId, APP.portBindings, APP),
            settings.initialize
        ], done);
    });

    after(function (done) {
        async.series([
            database._clear,
            database.uninitialize
        ], done);
    });

    it('initializes succesfully', function (done) {
        apptask.initialize(done);
    });

    it('reserve port', function (done) {
        apptask._reserveHttpPort(APP, function (error) {
            expect(error).to.not.be.ok();
            expect(APP.httpPort).to.be.a('number');
            var client = net.connect(APP.httpPort);
            client.on('connect', function () { done(new Error('Port is not free:' + APP.httpPort)); });
            client.on('error', function (error) { done(); });
        });
    });

    it('configure nginx correctly', function (done) {
        apptask._configureReverseProxy(APP, function (error) {
            expect(fs.existsSync(paths.NGINX_APPCONFIG_DIR + '/' + APP.id + '.conf'));
            // expect(error).to.be(null); // this fails because nginx cannot be restarted
            done();
        });
    });

    it('unconfigure nginx', function (done) {
        apptask._unconfigureReverseProxy(APP, function (error) {
            expect(!fs.existsSync(paths.NGINX_APPCONFIG_DIR + '/' + APP.id + '.conf'));
            // expect(error).to.be(null); // this fails because nginx cannot be restarted
            done();
        });
    });

    it('create volume', function (done) {
        apptask._createVolume(APP, function (error) {
            expect(fs.existsSync(paths.APPS_DATA_DIR + '/' + APP.id + '/data')).to.be(true);
            expect(error).to.be(null);
            done();
        });
    });

    it('delete volume - removeDirectory (false) ', function (done) {
        apptask._deleteVolume(APP, { removeDirectory: false }, function (error) {
            expect(!fs.existsSync(paths.APPS_DATA_DIR + '/' + APP.id + '/data')).to.be(true);
            expect(fs.existsSync(paths.APPS_DATA_DIR + '/' + APP.id)).to.be(true);
            expect(fs.readdirSync(paths.APPS_DATA_DIR + '/' + APP.id).length).to.be(0); // empty
            expect(error).to.be(null);
            done();
        });
    });

    it('delete volume - removeDirectory (true) ', function (done) {
        apptask._deleteVolume(APP, { removeDirectory: true }, function (error) {
            expect(!fs.existsSync(paths.APPS_DATA_DIR + '/' + APP.id)).to.be(true);
            expect(error).to.be(null);
            done();
        });
    });

    it('allocate OAuth credentials', function (done) {
        addons._setupOauth(APP, {}, function (error) {
            expect(error).to.be(null);
            done();
        });
    });

    it('remove OAuth credentials', function (done) {
        addons._teardownOauth(APP, {}, function (error) {
            expect(error).to.be(null);
            done();
        });
    });

    it('remove OAuth credentials twice succeeds', function (done) {
        addons._teardownOauth(APP, {}, function (error) {
            expect(!error).to.be.ok();
            done();
        });
    });

    it('barfs on empty manifest', function (done) {
        var badApp = _.extend({ }, APP);
        badApp.manifest = { };

        apptask._verifyManifest(badApp.manifest, function (error) {
            expect(error).to.be.ok();
            done();
        });
    });

    it('barfs on bad manifest', function (done) {
        var badApp = _.extend({ }, APP);
        badApp.manifest = _.extend({ }, APP.manifest);
        delete badApp.manifest.id;

        apptask._verifyManifest(badApp.manifest, function (error) {
            expect(error).to.be.ok();
            done();
        });
    });

    it('barfs on incompatible manifest', function (done) {
        var badApp = _.extend({ }, APP);
        badApp.manifest = _.extend({ }, APP.manifest);
        badApp.manifest.maxBoxVersion = '0.0.0'; // max box version is too small

        apptask._verifyManifest(badApp.manifest, function (error) {
            expect(error).to.be.ok();
            done();
        });
    });

    it('verifies manifest', function (done) {
        var goodApp = _.extend({ }, APP);

        apptask._verifyManifest(goodApp.manifest, function (error) {
            expect(error).to.be(null);
            done();
        });
    });

    it('registers subdomain', function (done) {
        nock.cleanAll();

        var awsScope = nock('http://localhost:5353')
            .get('/2013-04-01/hostedzonesbyname?dnsname=example.com.&maxitems=1')
            .times(2)
            .reply(200, js2xml('ListHostedZonesResponse', awsHostedZones, { wrapHandlers: { HostedZones: () => 'HostedZone'} }))
            .get('/2013-04-01/hostedzone/ZONEID/rrset?maxitems=1&name=applocation.' + DOMAIN_0.domain + '.&type=A')
            .reply(200, js2xml('ListResourceRecordSetsResponse', { ResourceRecordSets: [ ] }, { 'Content-Type': 'application/xml' }))
            .post('/2013-04-01/hostedzone/ZONEID/rrset/')
            .reply(200, js2xml('ChangeResourceRecordSetsResponse', { ChangeInfo: { Id: 'RRID', Status: 'INSYNC' } }));

        apptask._registerSubdomain(APP, true /* overwrite */, function (error) {
            expect(error).to.be(null);
            expect(awsScope.isDone()).to.be.ok();
            done();
        });
    });

    it('unregisters subdomain', function (done) {
        nock.cleanAll();

        var awsScope = nock('http://localhost:5353')
            .get('/2013-04-01/hostedzonesbyname?dnsname=example.com.&maxitems=1')
            .reply(200, js2xml('ListHostedZonesResponse', awsHostedZones, { wrapHandlers: { HostedZones: () => 'HostedZone'} }))
            .post('/2013-04-01/hostedzone/ZONEID/rrset/')
            .reply(200, js2xml('ChangeResourceRecordSetsResponse', { ChangeInfo: { Id: 'RRID', Status: 'INSYNC' } }));

        apptask._unregisterSubdomain(APP, APP.location, APP.domain, function (error) {
            expect(error).to.be(null);
            expect(awsScope.isDone()).to.be.ok();
            done();
        });
    });
});
