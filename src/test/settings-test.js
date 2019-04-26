/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../config.js'),
    constants = require('../constants.js'),
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

var DOMAIN_0 = 'example.com';

function setup(done) {
    config._reset();
    config.set('fqdn', DOMAIN_0);
    config.set('provider', 'caas');
    nock.cleanAll();

    async.series([
        database.initialize,
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
        database._clear,
        database.uninitialize
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

        it('can get default app_autoupdate_pattern', function (done) {
            settings.getAppAutoupdatePattern(function (error, pattern) {
                expect(error).to.be(null);
                expect(pattern).to.be('00 30 1,3,5,23 * * *');
                done();
            });
        });

        it('can get default box_autoupdate_pattern', function (done) {
            settings.getBoxAutoupdatePattern(function (error, pattern) {
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

        it('can set backup config', function (done) {
            nock(config.apiServerOrigin())
                .post(`/api/v1/caas/boxes/${DOMAIN_0}/awscredentials?token=TOKEN`)
                .reply(201, { credentials: { AccessKeyId: 'accessKeyId', SecretAccessKey: 'secretAccessKey', SessionToken: 'sessionToken' } });

            settings.setBackupConfig({ provider: 'caas', fqdn: DOMAIN_0, token: 'TOKEN', format: 'tgz', prefix: 'boxid', bucket: 'bucket' }, function (error) {
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

        it('can get all values', function (done) {
            settings.getAll(function (error, allSettings) {
                expect(error).to.be(null);
                expect(allSettings[settings.TIME_ZONE_KEY]).to.be.a('string');
                expect(allSettings[settings.APP_AUTOUPDATE_PATTERN_KEY]).to.be.a('string');
                expect(allSettings[settings.BOX_AUTOUPDATE_PATTERN_KEY]).to.be.a('string');
                expect(allSettings[settings.CLOUDRON_NAME_KEY]).to.be.a('string');
                done();
            });
        });
    });
});
