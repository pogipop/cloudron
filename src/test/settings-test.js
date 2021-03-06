/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    database = require('../database.js'),
    expect = require('expect.js'),
    MockS3 = require('mock-aws-s3'),
    nock = require('nock'),
    os = require('os'),
    path = require('path'),
    rimraf = require('rimraf'),
    s3 = require('../storage/s3.js'),
    settings = require('../settings.js');

function setup(done) {
    nock.cleanAll();

    async.series([
        database.initialize,
        function (callback) {
            MockS3.config.basePath = path.join(os.tmpdir(), 's3-settings-test-buckets/');

            s3._mockInject(MockS3);

            callback();
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

        it('can get backup config', function (done) {
            settings.getBackupConfig(function (error, backupConfig) {
                expect(error).to.be(null);
                expect(backupConfig.provider).to.be('filesystem');
                expect(backupConfig.backupFolder).to.be('/var/backups');
                done();
            });
        });

        it('can get default unstable apps setting', function (done) {
            settings.getUnstableAppsConfig(function (error, enabled) {
                expect(error).to.be(null);
                expect(enabled).to.be(false);
                done();
            });
        });

        it('can set unstable apps setting', function (done) {
            settings.setUnstableAppsConfig(true, function (error) {
                expect(error).to.be(null);

                settings.getUnstableAppsConfig(function (error, enabled) {
                    expect(error).to.be(null);
                    expect(enabled).to.be(true);
                    done();
                });
            });
        });

        it('can get all values', function (done) {
            settings.getAll(function (error, allSettings) {
                expect(error).to.be(null);
                expect(allSettings[settings.TIME_ZONE_KEY]).to.be.a('string');
                expect(allSettings[settings.APP_AUTOUPDATE_PATTERN_KEY]).to.be.a('string');
                expect(allSettings[settings.BOX_AUTOUPDATE_PATTERN_KEY]).to.be.a('string');
                expect(allSettings[settings.CLOUDRON_NAME_KEY]).to.be.a('string');
                expect(allSettings[settings.UNSTABLE_APPS_KEY]).to.be.a('boolean');
                done();
            });
        });
    });
});
