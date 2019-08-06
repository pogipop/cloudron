'use strict';

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */
/* global xit:false */

var appdb = require('../../appdb.js'),
    apps = require('../../apps.js'),
    assert = require('assert'),
    async = require('async'),
    child_process = require('child_process'),
    clients = require('../../clients.js'),
    constants = require('../../constants.js'),
    database = require('../../database.js'),
    docker = require('../../docker.js').connection,
    expect = require('expect.js'),
    fs = require('fs'),
    hat = require('../../hat.js'),
    hock = require('hock'),
    http = require('http'),
    https = require('https'),
    ldap = require('../../ldap.js'),
    net = require('net'),
    nock = require('nock'),
    path = require('path'),
    paths = require('../../paths.js'),
    platform = require('../../platform.js'),
    safe = require('safetydance'),
    server = require('../../server.js'),
    settings = require('../../settings.js'),
    settingsdb = require('../../settingsdb.js'),
    superagent = require('superagent'),
    taskmanager = require('../../taskmanager.js'),
    tokendb = require('../../tokendb.js'),
    url = require('url'),
    uuid = require('uuid'),
    _ = require('underscore');

var SERVER_URL = 'http://localhost:' + constants.PORT;

// Test image information
var TEST_IMAGE_REPO = 'cloudron/test';
var TEST_IMAGE_TAG = '25.19.0';
var TEST_IMAGE = TEST_IMAGE_REPO + ':' + TEST_IMAGE_TAG;

const DOMAIN_0 = {
    domain: 'example-apps-test.com',
    adminFqdn: 'my.example-apps-test.com',
    zoneName: 'example-apps-test.com',
    config: {},
    provider: 'noop',
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

var APP_STORE_ID = 'test', APP_ID;
var APP_LOCATION = 'appslocation';
var APP_LOCATION_2 = 'appslocationtwo';
var APP_LOCATION_NEW = 'appslocationnew';

var APP_MANIFEST = JSON.parse(fs.readFileSync(__dirname + '/../../../../test-app/CloudronManifest.json', 'utf8'));
APP_MANIFEST.dockerImage = TEST_IMAGE;

const USERNAME = 'superadmin';
const PASSWORD = 'Foobar?1337';
const EMAIL ='admin@me.com';

const USER_1_APPSTORE_TOKEN = 'appstoretoken';
const USERNAME_1 = 'user';
const EMAIL_1 ='user@me.com';
var user_1_id = null;

// authentication token
var token = null;
var token_1 = null;

function startDockerProxy(interceptor, callback) {
    assert.strictEqual(typeof interceptor, 'function');

    return http.createServer(function (req, res) {
        if (interceptor(req, res)) return;

        // rejectUnauthorized should not be required but it doesn't work without it
        var options = _.extend({ }, docker.options, { method: req.method, path: req.url, headers: req.headers, rejectUnauthorized: false });
        delete options.protocol; // https module doesn't like this key
        var proto = docker.options.protocol === 'https' ? https : http;
        var dockerRequest = proto.request(options, function (dockerResponse) {
            res.writeHead(dockerResponse.statusCode, dockerResponse.headers);
            dockerResponse.on('error', console.error);
            dockerResponse.pipe(res, { end: true });
        });

        req.on('error', console.error);
        if (!req.readable) {
            dockerRequest.end();
        } else {
            req.pipe(dockerRequest, { end: true });
        }

    }).listen(5687, callback);
}

function checkAddons(appEntry, done) {
    async.retry({ times: 15, interval: 3000 }, function (callback) {
        // this was previously written with superagent but it was getting sporadic EPIPE
        var req = http.get({ hostname: 'localhost', port: appEntry.httpPort, path: '/check_addons?username=' + USERNAME + '&password=' + PASSWORD });
        req.on('error', callback);
        req.on('response', function (res) {
            if (res.statusCode !== 200) return callback('app returned non-200 status : ' + res.statusCode);

            var d = '';
            res.on('data', function (chunk) { d += chunk.toString('utf8'); });
            res.on('end', function () {
                var body = JSON.parse(d);

                delete body.recvmail; // unclear why dovecot mail delivery won't work
                delete body.stdenv; // cannot access APP_ORIGIN
                delete body.email; // sieve will fail not sure why yet
                delete body.docker; // TODO fix this for some reason we cannot connect to the docker proxy on port 3003

                for (var key in body) {
                    if (body[key] !== 'OK') {
                        console.log('Not done yet: ' + JSON.stringify(body));
                        return callback('Not done yet: ' + JSON.stringify(body));
                    }
                }

                callback();
            });
        });

        req.end();
    }, done);
}

function checkRedis(containerId, done) {
    var redisIp, exportedRedisPort;

    docker.getContainer(containerId).inspect(function (error, data) {
        expect(error).to.not.be.ok();
        expect(data).to.be.ok();

        redisIp = safe.query(data, 'NetworkSettings.Networks.cloudron.IPAddress');
        expect(redisIp).to.be.ok();

        exportedRedisPort = safe.query(data, 'NetworkSettings.Ports.6379/tcp');
        expect(exportedRedisPort).to.be(null);

        done();
    });
}

var dockerProxy;
var imageDeleted;
var imageCreated;

function waitForSetup(done) {
    async.retry({ times: 5, interval: 4000 }, function (retryCallback) {
        superagent.get(SERVER_URL + '/api/v1/cloudron/status')
            .end(function (error, result) {
                if (!result || result.statusCode !== 200) return retryCallback(new Error('Bad result'));

                if (!result.body.setup.active && result.body.setup.errorMessage === '' && result.body.adminFqdn) return retryCallback();

                retryCallback(new Error('Not done yet: ' + JSON.stringify(result.body)));
            });
    }, done);
}

function startBox(done) {
    console.log('Starting box code...');

    imageDeleted = false;
    imageCreated = false;

    process.env.TEST_CREATE_INFRA = 1;

    safe.fs.unlinkSync(paths.INFRA_VERSION_FILE);

    async.series([
        // first clear, then start server. otherwise, taskmanager spins up tasks for obsolete appIds
        database.initialize,
        database._clear,
        server.start,
        ldap.start,
        settings._setApiServerOrigin.bind(null, 'http://localhost:6060'),

        function (callback) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/setup')
                .send({ dnsConfig: DOMAIN_0 })
                .end(function (error, result) {
                    expect(result).to.be.ok();
                    expect(result.statusCode).to.eql(200);

                    waitForSetup(callback);
                });
        },

        function (callback) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                .end(function (error, result) {
                    expect(result).to.be.ok();
                    expect(result.statusCode).to.eql(201);

                    // stash for further use
                    token = result.body.token;

                    callback();
                });
        },

        function (callback) {
            superagent.post(SERVER_URL + '/api/v1/users')
                .query({ access_token: token })
                .send({ username: USERNAME_1, email: EMAIL_1, invite: false })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(201);

                    user_1_id = res.body.id;
                    token_1 = hat(8 * 32);

                    // HACK to get a token for second user (passwords are generated and the user should have gotten a password setup link...)
                    tokendb.add({ id: 'tid-1', accessToken: token_1, identifier: user_1_id, clientId: 'cid-sdk', expires: Date.now() + 1000000, scope: 'apps', name: '' }, callback); // cid-sdk means we don't need to send password
                });
        },

        function (callback) {
            dockerProxy = startDockerProxy(function interceptor(req, res) {
                if (req.method === 'POST' && req.url === '/images/create?fromImage=' + encodeURIComponent(TEST_IMAGE_REPO) + '&tag=' + TEST_IMAGE_TAG) {
                    imageCreated = true;
                    res.writeHead(200);
                    res.end();
                    return true;
                } else if (req.method === 'DELETE' && req.url === '/images/' + TEST_IMAGE + '?force=false&noprune=false') {
                    imageDeleted = true;
                    res.writeHead(200);
                    res.end();
                    return true;
                }
                return false;
            }, callback);
        },

        function (callback) {
            process.stdout.write('Waiting for platform to be ready...');
            async.retry({ times: 500, interval: 1000 }, function (retryCallback) {
                if (platform._isReady) return retryCallback();
                process.stdout.write('.');
                retryCallback('Platform not ready yet');
            }, function (error) {
                if (error) return callback(error);
                console.log();
                console.log('Platform is ready');
                callback();
            });
        }
    ], done);
}

function stopBox(done) {
    console.log('Stopping box code...');

    delete process.env.TEST_CREATE_INFRA;

    child_process.execSync('docker ps -qa --filter \'network=cloudron\' | xargs --no-run-if-empty docker rm -f');

    // db is not cleaned up here since it's too late to call it after server.stop. if called before server.stop taskmanager apptasks are unhappy :/
    async.series([
        dockerProxy.close.bind(dockerProxy),
        taskmanager._stopPendingTasks,
        taskmanager._waitForPendingTasks,
        appdb._clear,
        server.stop,
        ldap.stop
    ], done);
}

describe('App API', function () {
    before(startBox);
    after(stopBox);

    it('app install fails - missing manifest', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('appStoreId or manifest is required');
                done();
            });
    });

    it('app install fails - null manifest', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: null })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('appStoreId or manifest is required');
                done();
            });
    });

    it('app install fails - bad manifest format', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: 'epic' })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('manifest must be an object');
                done();
            });
    });

    it('app install fails - empty appStoreId format', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: null, appStoreId: '' })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('appStoreId or manifest is required');
                done();
            });
    });

    it('app install fails - invalid json', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send('garbage')
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
    });

    it('app install fails - missing domain', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: APP_MANIFEST, location: 'some', accessRestriction: null })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('domain is required');
                done();
            });
    });

    it('app install fails - non-existing domain', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: APP_MANIFEST, location: 'some', accessRestriction: null, domain: 'doesnotexist.com' })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(404);
                expect(res.body.message).to.eql('No such domain');
                done();
            });
    });

    it('app install fails - invalid location type', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: APP_MANIFEST, location: 42, accessRestriction: null, domain: DOMAIN_0.domain })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.eql('location is required');
                done();
            });
    });

    it('app install fails - reserved admin location', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: APP_MANIFEST, location: 'my', accessRestriction: null, domain: DOMAIN_0.domain })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.contain('my is reserved');
                done();
            });
    });

    it('app install fails - reserved smtp location', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: APP_MANIFEST, location: constants.SMTP_LOCATION, accessRestriction: null, domain: DOMAIN_0.domain })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.contain(constants.SMTP_LOCATION + ' is reserved');
                done();
            });
    });

    it('app install fails - portBindings must be object', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: APP_MANIFEST, location: APP_LOCATION, portBindings: 23, accessRestriction: null, domain: DOMAIN_0.domain })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.contain('portBindings must be an object');
                done();
            });
    });

    it('app install fails - accessRestriction is required', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: APP_MANIFEST, location: APP_LOCATION, portBindings: {}, domain: DOMAIN_0.domain })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.contain('accessRestriction is required');
                done();
            });
    });

    it('app install fails - accessRestriction type is wrong', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: APP_MANIFEST, location: APP_LOCATION, portBindings: {}, accessRestriction: '', domain: DOMAIN_0.domain })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                expect(res.body.message).to.contain('accessRestriction is required');
                done();
            });
    });

    it('app install fails for non admin', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token_1 })
            .send({ manifest: APP_MANIFEST, location: APP_LOCATION, portBindings: null, accessRestriction: null, domain: DOMAIN_0.domain })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
    });

    it('app install fails because manifest download fails', function (done) {
        var fake = nock(settings.apiServerOrigin()).get('/api/v1/apps/test').reply(404, {});

        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ appStoreId: APP_STORE_ID, location: APP_LOCATION, portBindings: null, domain: DOMAIN_0.domain, accessRestriction: { users: [ 'someuser' ], groups: [] } })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(404);
                expect(fake.isDone()).to.be.ok();
                done();
            });
    });

    it('app install fails due to purchase failure', function (done) {
        var fake1 = nock(settings.apiServerOrigin()).get('/api/v1/apps/test').reply(200, { manifest: APP_MANIFEST });

        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ appStoreId: APP_STORE_ID, location: APP_LOCATION, domain: DOMAIN_0.domain, portBindings: null, accessRestriction: null })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(424);
                expect(fake1.isDone()).to.be.ok();
                done();
            });
    });

    it('app install succeeds with purchase', function (done) {
        var fake2 = nock(settings.apiServerOrigin()).get('/api/v1/apps/' + APP_STORE_ID).reply(200, { manifest: APP_MANIFEST });
        var fake3 = nock(settings.apiServerOrigin()).post(function (uri) { return uri.indexOf('/api/v1/cloudronapps') >= 0; }, (body) => body.appstoreId === APP_STORE_ID && body.manifestId === APP_MANIFEST.id && body.appId).reply(201, { });

        settingsdb.set(settings.CLOUDRON_TOKEN_KEY, USER_1_APPSTORE_TOKEN, function (error) {
            if (error) return done(error);

            superagent.post(SERVER_URL + '/api/v1/apps/install')
                .query({ access_token: token })
                .send({ appStoreId: APP_STORE_ID, location: APP_LOCATION, domain: DOMAIN_0.domain, portBindings: null, accessRestriction: { users: [ 'someuser' ], groups: [] } })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);
                    expect(res.body.id).to.be.a('string');
                    APP_ID = res.body.id;
                    expect(fake2.isDone()).to.be.ok();
                    expect(fake3.isDone()).to.be.ok();
                    done();
                });
        });
    });

    it('app install fails because of conflicting location', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ manifest: APP_MANIFEST, location: APP_LOCATION, domain: DOMAIN_0.domain, portBindings: null, accessRestriction: null })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(409);
                done();
            });
    });

    it('can get app status', function (done) {
        superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID)
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.id).to.eql(APP_ID);
                expect(res.body.installationState).to.be.ok();
                done();
            });
    });

    it('cannot get invalid app status', function (done) {
        superagent.get(SERVER_URL + '/api/v1/apps/kubachi')
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(404);
                done();
            });
    });

    it('can get all apps', function (done) {
        superagent.get(SERVER_URL + '/api/v1/apps')
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.apps).to.be.an('array');
                expect(res.body.apps[0].id).to.eql(APP_ID);
                expect(res.body.apps[0].installationState).to.be.ok();
                done();
            });
    });

    it('non admin cannot see the app due to accessRestriction', function (done) {
        superagent.get(SERVER_URL + '/api/v1/apps')
            .query({ access_token: token_1 })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                expect(res.body.apps).to.be.an('array');
                expect(res.body.apps.length).to.equal(0);
                done();
            });
    });

    it('cannot uninstall invalid app', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/whatever/uninstall')
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(404);
                done();
            });
    });

    it('non admin cannot uninstall app', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/uninstall')
            .query({ access_token: token_1 })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
    });

    it('can uninstall app', function (done) {
        var fake1 = nock(settings.apiServerOrigin()).get(function (uri) { return uri.indexOf('/api/v1/cloudronapps/') >= 0; }).reply(200, { });
        var fake2 = nock(settings.apiServerOrigin()).delete(function (uri) { return uri.indexOf('/api/v1/cloudronapps/') >= 0; }).reply(204, { });

        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/uninstall')
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                expect(fake1.isDone()).to.be.ok();
                expect(fake2.isDone()).to.be.ok();
                done();
            });
    });

    it('app install succeeds again', function (done) {
        var fake1 = nock(settings.apiServerOrigin()).get('/api/v1/apps/' + APP_STORE_ID).reply(200, { manifest: APP_MANIFEST });
        var fake2 = nock(settings.apiServerOrigin()).post(function (uri) { return uri.indexOf('/api/v1/cloudronapps') >= 0; }, (body) => body.appstoreId === APP_STORE_ID && body.manifestId === APP_MANIFEST.id && body.appId).reply(201, { });

        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ appStoreId: APP_STORE_ID, location: APP_LOCATION_2, domain: DOMAIN_0.domain, portBindings: null, accessRestriction: null })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                expect(res.body.id).to.be.a('string');
                APP_ID = res.body.id;
                expect(fake1.isDone()).to.be.ok();
                expect(fake2.isDone()).to.be.ok();
                done();
            });
    });

    it('app install fails with developer token', function (done) {
        superagent.post(SERVER_URL + '/api/v1/developer/login')
            .send({ username: USERNAME, password: PASSWORD })
            .end(function (error, result) {
                expect(error).to.not.be.ok();
                expect(result.statusCode).to.equal(200);
                expect(new Date(result.body.expires).toString()).to.not.be('Invalid Date');
                expect(result.body.accessToken).to.be.a('string');

                // overwrite non dev token
                token = result.body.accessToken;

                superagent.post(SERVER_URL + '/api/v1/apps/install')
                    .query({ access_token: token })
                    .send({ manifest: APP_MANIFEST, location: APP_LOCATION+APP_LOCATION, domain: DOMAIN_0.domain, portBindings: null, accessRestriction: null })
                    .end(function (err, res) {
                        expect(res.statusCode).to.equal(424); // appstore purchase external error
                        done();
                    });
            });
    });
});

describe('App installation', function () {
    var apiHockInstance = hock.createHock({ throwOnUnmatched: false });
    var validCert1, validKey1;

    before(function (done) {
        child_process.execSync('openssl req -subj "/CN=*.' + DOMAIN_0.domain + '/O=My Company Name LTD./C=US" -new -newkey rsa:2048 -days 365 -nodes -x509 -keyout /tmp/server.key -out /tmp/server.crt');
        validKey1 = fs.readFileSync('/tmp/server.key', 'utf8');
        validCert1 = fs.readFileSync('/tmp/server.crt', 'utf8');

        APP_ID = uuid.v4();

        async.series([
            startBox,

            function (callback) {
                apiHockInstance
                    .get('/api/v1/apps/' + APP_STORE_ID + '/versions/' + APP_MANIFEST.version + '/icon')
                    .replyWithFile(200, path.resolve(__dirname, '../../../assets/avatar.png'));

                var port = parseInt(url.parse(settings.apiServerOrigin()).port, 10);
                http.createServer(apiHockInstance.handler).listen(port, callback);
            },

            function (callback) {
                settingsdb.set(settings.CLOUDRON_TOKEN_KEY, USER_1_APPSTORE_TOKEN, function (error) {
                    if (error) return callback(error);

                    callback();
                });
            }
        ], done);
    });

    var appResult = null, appEntry = null;

    it('can install test app', function (done) {
        var fake1 = nock(settings.apiServerOrigin()).get('/api/v1/apps/' + APP_STORE_ID).reply(200, { manifest: APP_MANIFEST });
        var fake2 = nock(settings.apiServerOrigin()).post(function (uri) { return uri.indexOf('/api/v1/cloudronapps') >= 0; }, (body) => body.appstoreId === APP_STORE_ID && body.manifestId === APP_MANIFEST.id && body.appId).reply(201, { });

        var count = 0;
        function checkInstallStatus() {
            superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID)
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);

                    if (res.body.installationState === appdb.ISTATE_INSTALLED) { appResult = res.body; return done(null); }
                    if (res.body.installationState === appdb.ISTATE_ERROR) return done(new Error('Install error'));
                    if (++count > 500) return done(new Error('Timedout'));

                    setTimeout(checkInstallStatus, 1000);
                });
        }

        superagent.post(SERVER_URL + '/api/v1/apps/install')
            .query({ access_token: token })
            .send({ appStoreId: APP_STORE_ID, location: APP_LOCATION, domain: DOMAIN_0.domain, portBindings: { ECHO_SERVER_PORT: 7171 }, accessRestriction: null })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                expect(fake1.isDone()).to.be.ok();
                expect(fake2.isDone()).to.be.ok();
                APP_ID = res.body.id;

                checkInstallStatus();
            });
    });

    xit('installation - image created', function (done) {
        expect(imageCreated).to.be.ok();
        done();
    });

    it('installation - can get app', function (done) {
        apps.get(appResult.id, function (error, app) {
            expect(!error).to.be.ok();
            expect(app).to.be.an('object');
            appEntry = app;
            done();
        });
    });

    it('installation - container created', function (done) {
        expect(appResult.containerId).to.be(undefined);
        expect(appEntry.containerId).to.be.ok();
        docker.getContainer(appEntry.containerId).inspect(function (error, data) {
            expect(error).to.not.be.ok();
            expect(data.Config.ExposedPorts['7777/tcp']).to.eql({ });
            expect(data.Config.Env).to.contain('CLOUDRON_WEBADMIN_ORIGIN=' + settings.adminOrigin());
            expect(data.Config.Env).to.contain('CLOUDRON_API_ORIGIN=' + settings.adminOrigin());
            expect(data.Config.Env).to.contain('CLOUDRON=1');
            expect(data.Config.Env).to.contain('CLOUDRON_APP_ORIGIN=https://' + APP_LOCATION + '.' + DOMAIN_0.domain);
            expect(data.Config.Env).to.contain('CLOUDRON_APP_DOMAIN=' + APP_LOCATION + '.' + DOMAIN_0.domain);
            // Hostname must not be set of app fqdn or app location!
            expect(data.Config.Hostname).to.not.contain(APP_LOCATION);
            expect(data.Config.Env).to.contain('ECHO_SERVER_PORT=7171');
            expect(data.HostConfig.PortBindings['7778/tcp'][0].HostPort).to.eql('7171');
            done();
        });
    });

    it('installation - nginx config', function (done) {
        expect(fs.existsSync(paths.NGINX_APPCONFIG_DIR + '/' + APP_LOCATION + '.conf'));
        done();
    });

    it('installation - registered subdomain', function (done) {
        // this is checked in unregister subdomain testcase
        done();
    });

    it('installation - volume created', function (done) {
        expect(fs.existsSync(paths.APPS_DATA_DIR + '/' + APP_ID));
        let volume = docker.getVolume(APP_ID + '-localstorage');
        volume.inspect(function (error, volume) {
            expect(error).to.be(null);
            expect(volume.Labels.appId).to.eql(APP_ID);
            expect(volume.Options.device).to.eql(paths.APPS_DATA_DIR + '/' + APP_ID + '/data');
            done();
        });
    });

    it('installation - http is up and running', function (done) {
        var tryCount = 20;

        // TODO what does that check for?
        expect(appResult.httpPort).to.be(undefined);

        (function healthCheck() {
            superagent.get('http://localhost:' + appEntry.httpPort + appResult.manifest.healthCheckPath)
                .end(function (err, res) {
                    if (err || res.statusCode !== 200) {
                        if (--tryCount === 0) {
                            console.log('Unable to curl http://localhost:' + appEntry.httpPort + appResult.manifest.healthCheckPath);
                            return done(new Error('Timedout'));
                        }
                        return setTimeout(healthCheck, 2000);
                    }

                    expect(!err).to.be.ok();
                    expect(res.statusCode).to.equal(200);
                    done();
                });
        })();
    });

    it('installation - tcp port mapping works', function (done) {
        var client = net.connect(7171);
        client.on('data', function (data) {
            expect(data.toString()).to.eql('ECHO_SERVER_PORT=7171');
            done();
        });
        client.on('error', done);
    });

    it('installation - running container has volume mounted', function (done) {
        docker.getContainer(appEntry.containerId).inspect(function (error, data) {
            expect(error).to.not.be.ok();
            expect(data.Mounts.filter(function (mount) { return mount.Destination === '/app/data'; })[0].Type).to.eql('volume');

            done();
        });
    });

    it('installation - app responds to http request', function (done) {
        superagent.get('http://localhost:' + appEntry.httpPort).end(function (err, res) {
            expect(!err).to.be.ok();
            expect(res.statusCode).to.equal(200);
            done();
        });
    });

    it('installation - oauth addon config', function (done) {
        var appContainer = docker.getContainer(appEntry.containerId);
        appContainer.inspect(function (error, data) {
            expect(error).to.not.be.ok();

            clients.getByAppIdAndType(APP_ID, clients.TYPE_OAUTH, function (error, client) {
                expect(error).to.not.be.ok();
                expect(client.id.length).to.be(40); // cid- + 32 hex chars (128 bits) + 4 hyphens
                expect(client.clientSecret.length).to.be(256); // 32 hex chars (8 * 256 bits)
                expect(data.Config.Env).to.contain('CLOUDRON_OAUTH_CLIENT_ID=' + client.id);
                expect(data.Config.Env).to.contain('CLOUDRON_OAUTH_CLIENT_SECRET=' + client.clientSecret);
                done();
            });
        });
    });

    it('installation - app can populate addons', function (done) {
        superagent.get(`http://localhost:${appEntry.httpPort}/populate_addons`).end(function (error, res) {
            expect(!error).to.be.ok();
            expect(res.statusCode).to.equal(200);
            for (var key in res.body) {
                expect(res.body[key]).to.be('OK');
            }
            done();
        });
    });

    it('installation - app can check addons', function (done) {
        console.log('This test can take a while as it waits for scheduler addon to tick 3');
        checkAddons(appEntry, done);
    });

    it('installation - redis addon created', function (done) {
        checkRedis('redis-' + APP_ID, done);
    });

    it('logs - stdout and stderr', function (done) {
        superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID + '/logs')
            .query({ access_token: token })
            .buffer(false)
            .end(function (err, res) {
                var data = '';
                res.on('data', function (d) { data += d.toString('utf8'); });
                res.on('end', function () {
                    expect(data.length).to.not.be(0);
                    done();
                });
                res.on('error', done);
            });
    });

    it('logStream - requires event-stream accept header', function (done) {
        superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID + '/logstream')
            .query({ access_token: token, fromLine: 0 })
            .end(function (err, res) {
                expect(res.statusCode).to.be(400);
                done();
            });
    });

    it('logStream - stream logs', function (done) {
        var options = {
            port: constants.PORT, host: 'localhost', path: '/api/v1/apps/' + APP_ID + '/logstream?access_token=' + token,
            headers: { 'Accept': 'text/event-stream', 'Connection': 'keep-alive' }
        };

        // superagent doesn't work. maybe https://github.com/visionmedia/superagent/issues/420
        var req = http.get(options, function (res) {
            var data = '';
            res.on('data', function (d) { data += d.toString('utf8'); });
            setTimeout(function checkData() {
                expect(data.length).to.not.be(0);
                data.split('\n').forEach(function (line) {
                    if (line.indexOf('id: ') !== 0) return;
                    expect(parseInt(line.substr(4), 10)).to.be.a('number'); // timestamp
                });

                req.abort();
                done();
            }, 1000);
            res.on('error', done);
        });

        req.on('error', done);
    });

    it('non admin cannot stop app', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/stop')
            .query({ access_token: token_1 })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
    });

    it('can stop app', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/stop')
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                done();
            });
    });

    it('did stop the app', function (done) {
        function waitForAppToDie() {
            superagent.get('http://localhost:' + appEntry.httpPort + appResult.manifest.healthCheckPath).end(function (err) {
                if (!err || err.code !== 'ECONNREFUSED') return setTimeout(waitForAppToDie, 500);

                // wait for app status to be updated
                superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID).query({ access_token: token }).end(function (error, result) {
                    if (error || result.statusCode !== 200 || result.body.runState !== 'stopped') return setTimeout(waitForAppToDie, 500);
                    done();
                });
            });
        }

        waitForAppToDie();
    });

    it('nonadmin cannot start app', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/start')
            .query({ access_token: token_1 })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
    });

    it('can start app', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/start')
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                done();
            });
    });

    it('did start the app', function (done) {
        var count = 0;
        function checkStartState() {
            superagent.get('http://localhost:' + appEntry.httpPort + appResult.manifest.healthCheckPath)
                .end(function (err, res) {
                    if (res && res.statusCode === 200) return done();
                    if (++count > 50) return done(new Error('Timedout'));
                    setTimeout(checkStartState, 500);
                });
        }

        checkStartState();
    });

    it('installation - app can check addons', function (done) {
        console.log('This test can take a while as it waits for scheduler addon to tick 2');
        checkAddons(appEntry, done);
    });

    function checkConfigureStatus(count, done) {
        assert.strictEqual(typeof count, 'number');
        assert.strictEqual(typeof done, 'function');

        superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID)
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(200);
                if (res.body.installationState === appdb.ISTATE_INSTALLED) { appResult = res.body; expect(appResult).to.be.ok(); return done(null); }
                if (res.body.installationState === appdb.ISTATE_ERROR) return done(new Error('Install error'));
                if (++count > 50) return done(new Error('Timedout'));
                setTimeout(checkConfigureStatus.bind(null, count, done), 1000);
            });
    }

    it('cannot reconfigure app with missing domain', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
            .query({ access_token: token })
            .send({ location: 'hellothre' })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
    });

    it('cannot reconfigure app with bad location', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
            .query({ access_token: token })
            .send({ location: 1234, domain: DOMAIN_0.domain })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
    });

    it('cannot reconfigure app with bad accessRestriction', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
            .query({ access_token: token })
            .send({ accessRestriction: false })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
    });

    it('cannot reconfigure app with only the cert, no key', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
            .query({ access_token: token })
            .send({ cert: validCert1 })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
    });

    it('cannot reconfigure app with only the key, no cert', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
            .query({ access_token: token })
            .send({ key: validKey1 })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
    });

    it('cannot reconfigure app with cert not being a string', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
            .query({ access_token: token })
            .send({ cert: 1234, key: validKey1 })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
    });

    it('cannot reconfigure app with key not being a string', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
            .query({ access_token: token })
            .send({ cert: validCert1, key: 1234 })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);
                done();
            });
    });

    it('cannot reconfigure app with invalid tags', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
            .query({ access_token: token })
            .send({ tags: 'foobar' })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(400);

                superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
                    .query({ access_token: token })
                    .send({ tags: ['hello', '', 'there' ] })
                    .end(function (err, res) {
                        expect(res.statusCode).to.equal(400);

                        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
                            .query({ access_token: token })
                            .send({ tags: ['hello', 1234, 'there' ] })
                            .end(function (err, res) {
                                expect(res.statusCode).to.equal(400);
                                done();
                            });
                    });
            });
    });

    it('non admin cannot reconfigure app', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
            .query({ access_token: token_1 })
            .send({ location: APP_LOCATION_NEW, domain: DOMAIN_0.domain, portBindings: { ECHO_SERVER_PORT: 7172 }, accessRestriction: null })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(403);
                done();
            });
    });

    it('can reconfigure app', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
            .query({ access_token: token })
            .send({ location: APP_LOCATION_NEW, domain: DOMAIN_0.domain, portBindings: { ECHO_SERVER_PORT: 7172 } })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                checkConfigureStatus(0, done);
            });
    });

    it('changed container id after reconfigure', function (done) {
        var oldContainerId = appEntry.containerId;
        apps.get(appResult.id, function (error, app) {
            expect(!error).to.be.ok();
            expect(app).to.be.an('object');
            appEntry = app;
            expect(appEntry.containerId).to.not.be(oldContainerId);
            done();
        });
    });

    it('port mapping works after reconfiguration', function (done) {
        setTimeout(function () {
            var client = net.connect(7172);
            client.on('data', function (data) {
                expect(data.toString()).to.eql('ECHO_SERVER_PORT=7172');
                done();
            });
            client.on('error', done);
        }, 2000);
    });

    it('reconfiguration - redis addon recreated', function (done) {
        checkRedis('redis-' + APP_ID, done);
    });

    it('installation - app can check addons', function (done) {
        console.log('This test can take a while as it waits for scheduler addon to tick 4');
        checkAddons(appEntry, done);
    });

    it('can reconfigure app with custom certificate', function (done) {
        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/configure')
            .query({ access_token: token })
            .send({ location: APP_LOCATION_NEW, domain: DOMAIN_0.domain, portBindings: { ECHO_SERVER_PORT: 7172 }, accessRestriction: null, cert: validCert1, key: validKey1 })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(202);
                checkConfigureStatus(0, done);
            });
    });

    it('can uninstall app', function (done) {
        var fake1 = nock(settings.apiServerOrigin()).get(function (uri) { return uri.indexOf('/api/v1/cloudronapps/') >= 0; }).reply(200, { });
        var fake2 = nock(settings.apiServerOrigin()).delete(function (uri) { return uri.indexOf('/api/v1/cloudronapps/') >= 0; }).reply(204, { });

        var count = 0;
        function checkUninstallStatus() {
            superagent.get(SERVER_URL + '/api/v1/apps/' + APP_ID)
                .query({ access_token: token })
                .end(function (err, res) {
                    if (res) console.log('Uninstall progress', res.body.installationState, res.body.installationProgress);

                    if (res.statusCode === 404) return done(null);
                    if (++count > 50) return done(new Error('Timedout'));
                    setTimeout(checkUninstallStatus, 1000);
                });
        }

        superagent.post(SERVER_URL + '/api/v1/apps/' + APP_ID + '/uninstall')
            .query({ access_token: token })
            .end(function (err, res) {
                expect(res.statusCode).to.equal(202);

                expect(fake1.isDone()).to.be.ok();
                expect(fake2.isDone()).to.be.ok();

                checkUninstallStatus();
            });
    });

    it('uninstalled - container destroyed', function (done) {
        docker.getContainer(appEntry.containerId).inspect(function (error, data) {
            expect(error).to.be.ok();
            expect(data).to.not.be.ok();
            done();
        });
    });

    xit('uninstalled - image destroyed', function (done) {
        expect(imageDeleted).to.be.ok();
        done();
    });

    it('uninstalled - volume destroyed', function (done) {
        expect(!fs.existsSync(paths.APPS_DATA_DIR + '/' + APP_ID));
        done();
    });

    it('uninstalled - unregistered subdomain', function (done) {
        apiHockInstance.done(function (error) { // checks if all the apiHockServer APIs were called
            expect(!error).to.be.ok();
            done();
        });
    });

    it('uninstalled - removed nginx', function (done) {
        expect(!fs.existsSync(paths.NGINX_APPCONFIG_DIR + '/' + APP_LOCATION + '.conf'));
        done();
    });

    it('uninstalled - removed redis addon', function (done) {
        docker.getContainer('redis-' + APP_ID).inspect(function (error) {
            expect(error).to.be.ok();
            done();
        });
    });

    // this is here so that --bail does not stop the box code
    it('stop box', stopBox);
});
