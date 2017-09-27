/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    backups = require('../backups.js'),
    BackupsError = require('../backups.js').BackupsError,
    config = require('../config.js'),
    database = require('../database.js'),
    expect = require('expect.js'),
    filesystem = require('../storage/filesystem.js'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    MockS3 = require('mock-aws-s3'),
    os = require('os'),
    path = require('path'),
    readdirp = require('readdirp'),
    rimraf = require('rimraf'),
    s3 = require('../storage/s3.js'),
    settings = require('../settings.js'),
    SettingsError = settings.SettingsError;

function setup(done) {
    config.set('provider', 'caas');

    async.series([
        database.initialize,
        settings.initialize,
        function (callback) {
            // a cloudron must have a backup config to startup
            settings.setBackupConfig({ provider: 'filesystem', format: 'tgz', backupFolder: '/tmp'}, function (error) {
                expect(error).to.be(null);
                callback();
            });
        }
    ], done);
}

function cleanup(done) {
    async.series([
        settings.uninitialize,
        database._clear
    ], done);
}

function compareDirectories(one, two, callback) {
    readdirp({ root: one }, function (error, treeOne) {
        if (error) return callback(error);

        readdirp({ root: two }, function (error, treeTwo) {
            if (error) return callback(error);

            var mismatch = [];

            function compareDirs(a, b) {
                a.forEach(function (tmpA) {
                    var found = b.find(function (tmpB) {
                        return tmpA.path === tmpB.path;
                    });

                    if (!found) mismatch.push(tmpA);
                });
            }

            function compareFiles(a, b) {
                a.forEach(function (tmpA) {
                    var found = b.find(function (tmpB) {
                        // TODO check file or symbolic link
                        return tmpA.path === tmpB.path && tmpA.mode === tmpB.mode;
                    });

                    if (!found) mismatch.push(tmpA);
                });
            }

            compareDirs(treeOne.directories, treeTwo.directories);
            compareDirs(treeTwo.directories, treeOne.directories);
            compareFiles(treeOne.files, treeTwo.files);
            compareFiles(treeTwo.files, treeOne.files);

            if (mismatch.length) {
                console.error('Files not found in both: %j', mismatch);
                return callback(new Error('file mismatch'));
            }

            callback(null);
        });
    });
}

describe('Storage', function () {
    describe('filesystem', function () {
        var gBackupId_1;
        var gBackupId_2;
        var gTmpFolder;
        var gSourceFolder;
        var gDestinationFolder;
        var gBackupConfig = {
            provider: 'filesystem',
            key: 'key',
            backupFolder: null,
            format: 'tgz'
        };

        before(function (done) {
            setup(function (error) {
                expect(error).to.be(null);

                gTmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-backup-test_'));

                gBackupConfig.backupFolder = path.join(gTmpFolder, 'backups/');
                gSourceFolder = path.join(__dirname, 'storage');
                gDestinationFolder = path.join(gTmpFolder, 'destination/');

                gBackupId_1 = backups._getBackupFilePath(gBackupConfig, 'someprefix/one');
                gBackupId_2 = backups._getBackupFilePath(gBackupConfig, 'someprefix/two');

                done();
            });
        });

        after(function (done) {
            cleanup(function (error) {
                expect(error).to.be(null);
                rimraf.sync(gTmpFolder);
                done();
            });
        });

        it('fails to set backup config for non-existing folder', function (done) {
            settings.setBackupConfig(gBackupConfig, function (error) {
                expect(error).to.be.a(SettingsError);
                expect(error.reason).to.equal(SettingsError.BAD_FIELD);

                done();
            });
        });

        it('succeeds to set backup config', function (done) {
            mkdirp.sync(gBackupConfig.backupFolder);

            settings.setBackupConfig(gBackupConfig, function (error) {
                expect(error).to.be(null);

                done();
            });
        });

        it('can backup', function (done) {
            var tarStream = backups._createTarPackStream(gSourceFolder, gBackupConfig.key);
            filesystem.upload(gBackupConfig, gBackupId_1, tarStream, function (error) {
                expect(error).to.be(null);

                done();
            });
        });

        it('can download', function (done) {
            filesystem.download(gBackupConfig, gBackupId_1, function (error, stream) {
                expect(error).to.be(null);

                backups._tarExtract(stream, gDestinationFolder, gBackupConfig.key || null, function (error) {
                    expect(error).to.be(null);

                    compareDirectories(path.join(gSourceFolder, 'data'), path.join(gDestinationFolder, 'data'), function (error) {
                        expect(error).to.equal(null);

                        compareDirectories(path.join(gSourceFolder, 'addon'), path.join(gDestinationFolder, 'addon'), function (error) {
                            expect(error).to.equal(null);

                            rimraf(gDestinationFolder, done);
                        });
                    });
                });
            });
        });

        it('can copy backup', function (done) {
            // will be verified after removing the first and restoring from the copy
            filesystem.copy(gBackupConfig, gBackupId_1, gBackupId_2, done);
        });

        it('can remove backup', function (done) {
            // will be verified with next test trying to download the removed one
            filesystem.remove(gBackupConfig, gBackupId_1, done);
        });

        it('cannot download deleted backup', function (done) {
            filesystem.download(gBackupConfig, gBackupId_1, function (error, stream) {
                expect(error).to.be(null);

                stream.on('error', function (error) {
                    expect(error).to.be.an('object');
                    expect(error.reason).to.equal(BackupsError.NOT_FOUND);

                    done();
                });
            });
        });

        it('can download backup copy', function (done) {
            filesystem.download(gBackupConfig, gBackupId_2, function (error, stream) {
                expect(error).to.be(null);

                backups._tarExtract(stream, gDestinationFolder, gBackupConfig.key || null, function (error) {
                    expect(error).to.be(null);

                    compareDirectories(path.join(gSourceFolder, 'data'), path.join(gDestinationFolder, 'data'), function (error) {
                        expect(error).to.equal(null);

                        compareDirectories(path.join(gSourceFolder, 'addon'), path.join(gDestinationFolder, 'addon'), function (error) {
                            expect(error).to.equal(null);

                            rimraf(gDestinationFolder, done);
                        });
                    });
                });
            });
        });

        it('can remove backup copy', function (done) {
            filesystem.remove(gBackupConfig, gBackupId_2, done);
        });
    });

    describe('s3', function () {
        this.timeout(10000);

        var gBackupId_1 = 'someprefix/one';
        var gBackupId_2 = 'someprefix/two';
        var gTmpFolder;
        var gSourceFolder;
        var gDestinationFolder;
        var gBackupConfig = {
            provider: 's3',
            key: 'key',
            prefix: 'unit.test',
            bucket: 'cloudron-storage-test',
            accessKeyId: 'testkeyid',
            secretAccessKey: 'testsecret',
            region: 'eu-central-1',
            format: 'tgz'
        };

        before(function (done) {
            MockS3.config.basePath = path.join(os.tmpdir(), 's3-backup-test-buckets/');

            s3._mockInject(MockS3);

            setup(function (error) {
                expect(error).to.be(null);

                gTmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 's3-backup-test_'));
                gSourceFolder = path.join(__dirname, 'storage');
                gDestinationFolder = path.join(gTmpFolder, 'destination/');

                settings.setBackupConfig(gBackupConfig, function (error) {
                    expect(error).to.be(null);

                    done();
                });
            });
        });

        after(function (done) {
            s3._mockRestore();
            rimraf.sync(MockS3.config.basePath);

            cleanup(function (error) {
                expect(error).to.be(null);
                rimraf.sync(gTmpFolder);
                done();
            });
        });

        it('can backup', function (done) {
            var tarStream = backups._createTarPackStream(gSourceFolder, gBackupConfig.key);
            s3.upload(gBackupConfig, gBackupId_1, tarStream, function (error) {
                expect(error).to.be(null);

                done();
            });
        });

        it('can download', function (done) {
            s3.download(gBackupConfig, gBackupId_1, function (error, stream) {
                expect(error).to.be(null);

                backups._tarExtract(stream, gDestinationFolder, gBackupConfig.key || null, function (error) {
                    expect(error).to.be(null);

                    compareDirectories(path.join(gSourceFolder, 'data'), path.join(gDestinationFolder, 'data'), function (error) {
                        expect(error).to.equal(null);

                        compareDirectories(path.join(gSourceFolder, 'addon'), path.join(gDestinationFolder, 'addon'), function (error) {
                            expect(error).to.equal(null);

                            rimraf(gDestinationFolder, done);
                        });
                    });
                });
            });
        });

        it('can copy backup', function (done) {
            // will be verified after removing the first and restoring from the copy
            s3.copy(gBackupConfig, gBackupId_1, gBackupId_2, done);
        });

        it('can remove backup', function (done) {
            // will be verified with next test trying to download the removed one
            s3.remove(gBackupConfig, gBackupId_1, done);
        });

        it('cannot download deleted backup', function (done) {
            s3.download(gBackupConfig, gBackupId_1, function (error, stream) {
                expect(error).to.be(null);

                stream.on('error', function (error) {
                    expect(error).to.be.an('object');
                    expect(error.reason).to.equal(BackupsError.NOT_FOUND);

                    done();
                });
            });
        });

        it('can download backup copy', function (done) {
            s3.download(gBackupConfig, gBackupId_2, function (error, stream) {
                expect(error).to.be(null);

                backups._tarExtract(stream, gDestinationFolder, gBackupConfig.key || null, function (error) {
                    expect(error).to.be(null);

                    compareDirectories(path.join(gSourceFolder, 'data'), path.join(gDestinationFolder, 'data'), function (error) {
                        expect(error).to.equal(null);

                        compareDirectories(path.join(gSourceFolder, 'addon'), path.join(gDestinationFolder, 'addon'), function (error) {
                            expect(error).to.equal(null);

                            rimraf(gDestinationFolder, done);
                        });
                    });
                });
            });
        });

        it('can remove backup copy', function (done) {
            s3.remove(gBackupConfig, gBackupId_2, done);
        });
    });
});
