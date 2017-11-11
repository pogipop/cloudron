/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../config.js'),
    database = require('../database.js'),
    expect = require('expect.js'),
    MockS3 = require('mock-aws-s3'),
    nock = require('nock'),
    os = require('os'),
    path = require('path'),
    rimraf = require('rimraf'),
    s3 = require('../storage/s3.js'),
    settings = require('../settings.js'),
    settingsdb = require('../settingsdb.js');

function setup(done) {
    config.set('provider', 'caas');
    nock.cleanAll();

    async.series([
        database.initialize,
        settings.initialize,
        function (callback) {
            MockS3.config.basePath = path.join(os.tmpdir(), 's3-settings-test-buckets/');

            s3._mockInject(MockS3);

            // a cloudron must have a backup config to startup
            settingsdb.set(settings.BACKUP_CONFIG_KEY, JSON.stringify({ provider: 'caas', token: 'foo', key: 'key', format: 'tgz'}), function (error) {
                expect(error).to.be(null);
                callback();
            });
        }
    ], done);
}

function cleanup(done) {
    s3._mockRestore();
    rimraf.sync(MockS3.config.basePath);

    async.series([
        settings.uninitialize,
        database._clear
    ], done);
}

describe('Settings', function () {
    describe('values', function () {
        before(setup);
        after(cleanup);

        it('can get default timezone', function (done) {
            settings.getTimeZone(function (error, tz) {
                expect(error).to.be(null);
                expect(tz.length).to.not.be(0);
                done();
            });
        });

        it('can get default autoupdate_pattern', function (done) {
            settings.getAutoupdatePattern(function (error, pattern) {
                expect(error).to.be(null);
                expect(pattern).to.be('00 00 1,3,5,23 * * *');
                done();
            });
        });

        it ('can get default cloudron name', function (done) {
            settings.getCloudronName(function (error, name) {
                expect(error).to.be(null);
                expect(name).to.be('Cloudron');
                done();
            });
        });

        it('can get default cloudron avatar', function (done) {
            settings.getCloudronAvatar(function (error, gravatar) {
                expect(error).to.be(null);
                expect(gravatar).to.be.a(Buffer);
                done();
            });
        });

        it('can get default developer mode', function (done) {
            settings.getDeveloperMode(function (error, enabled) {
                expect(error).to.be(null);
                expect(enabled).to.equal(true);
                done();
            });
        });

        it('can set developer mode', function (done) {
            settings.setDeveloperMode(true, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can get developer mode', function (done) {
            settings.getDeveloperMode(function (error, enabled) {
                expect(error).to.be(null);
                expect(enabled).to.equal(true);
                done();
            });
        });

        it('can set tls config', function (done) {
            settings.setTlsConfig({ provider: 'caas' }, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can get tls config', function (done) {
            settings.getTlsConfig(function (error, dnsConfig) {
                expect(error).to.be(null);
                expect(dnsConfig.provider).to.be('caas');
                done();
            });
        });

        it('can set backup config', function (done) {
            var scope2 = nock(config.apiServerOrigin())
                .post('/api/v1/boxes/' + config.fqdn() + '/awscredentials?token=TOKEN')
                .reply(201, { credentials: { AccessKeyId: 'accessKeyId', SecretAccessKey: 'secretAccessKey', SessionToken: 'sessionToken' } });

            settings.setBackupConfig({ provider: 'caas', token: 'TOKEN', format: 'tgz', prefix: 'boxid', bucket: 'bucket' }, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can get backup config', function (done) {
            settings.getBackupConfig(function (error, backupConfig) {
                expect(error).to.be(null);
                expect(backupConfig.provider).to.be('caas');
                expect(backupConfig.token).to.be('TOKEN');
                done();
            });
        });

        it('can set mail config', function (done) {
            settings.setMailConfig({ enabled: true }, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can get mail config', function (done) {
            settings.getMailConfig(function (error, mailConfig) {
                expect(error).to.be(null);
                expect(mailConfig.enabled).to.be(true);
                done();
            });
        });

        it('can set mail from validation', function (done) {
            settings.setMailFromValidation(true, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can get mail from validation', function (done) {
            settings.getMailFromValidation(function (error, enabled) {
                expect(error).to.be(null);
                expect(enabled).to.be(true);
                done();
            });
        });

        it('can enable mail digest', function (done) {
            settings.setEmailDigest(true, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can get mail digest', function (done) {
            settings.getEmailDigest(function (error, enabled) {
                expect(error).to.be(null);
                expect(enabled).to.be(true);
                done();
            });
        });

        it('can get mail relay', function (done) {
            settings.getMailRelay(function (error, address) {
                expect(error).to.be(null);
                expect(address).to.eql({ provider: 'cloudron-smtp' });
                done();
            });
        });

        it('can set mail relay', function (done) {
            var relay = { provider: 'external-smtp', host: 'mx.foo.com', port: 25 };
+            settingsdb.set(settings.MAIL_RELAY_KEY, JSON.stringify(relay), function (error) { // skip the mail server verify()
                expect(error).to.be(null);

                settings.getMailRelay(function (error, address) {
                    expect(error).to.be(null);
                    expect(address).to.eql(relay);
                    done();
                });
            });
        });

        it('can get catch all address', function (done) {
            settings.getCatchAllAddress(function (error, address) {
                expect(error).to.be(null);
                expect(address).to.eql([ ]);
                done();
            });
        });

        it('can set catch all address', function (done) {
            settings.setCatchAllAddress([ "user1", "user2" ], function (error) {
                expect(error).to.be(null);

                settings.getCatchAllAddress(function (error, address) {
                    expect(error).to.be(null);
                    expect(address).to.eql([ "user1", "user2" ]);
                    done();
                });
            });
        });

        it('can get all values', function (done) {
            settings.getAll(function (error, allSettings) {
                expect(error).to.be(null);
                expect(allSettings[settings.TIME_ZONE_KEY]).to.be.a('string');
                expect(allSettings[settings.AUTOUPDATE_PATTERN_KEY]).to.be.a('string');
                expect(allSettings[settings.CLOUDRON_NAME_KEY]).to.be.a('string');
                done();
            });
        });
    });
});
