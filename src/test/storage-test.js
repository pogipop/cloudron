/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    fs = require('fs'),
    os = require('os'),
    path = require('path'),
    readdirp = require('readdirp'),
    MockS3 = require('mock-aws-s3'),
    rimraf = require('rimraf'),
    mkdirp = require('mkdirp'),
    BackupsError = require('../backups.js').BackupsError,
    config = require('../config.js'),
    database = require('../database.js'),
    s3 = require('../storage/s3.js'),
    filesystem = require('../storage/filesystem.js'),
    expect = require('expect.js'),
    settings = require('../settings.js'),
    SettingsError = settings.SettingsError;

function setup(done) {
    config.set('provider', 'caas');

    async.series([
        database.initialize,
        settings.initialize,
        function (callback) {
            // a cloudron must have a backup config to startup
            settings.setBackupConfig({ provider: 'caas', token: 'foo', key: 'key'}, function (error) {
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
        var gBackupId_1 = 'someprefix/one';
        var gBackupId_2 = 'someprefix/two';
        var gTmpFolder;
        var gSourceFolder;
        var gDestinationFolder;
        var gBackupConfig = {
            provider: 'filesystem',
            key: 'key',
            backupFolder: null
        };

        before(function (done) {
            setup(function (error) {
                expect(error).to.be(null);

                gTmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-backup-test_'));

                gBackupConfig.backupFolder = path.join(gTmpFolder, 'backups/');
                gSourceFolder = path.join(__dirname, 'storage');
                gDestinationFolder = path.join(gTmpFolder, 'destination/');

                done();
            });
        });

        after(function (done) {
            cleanup(function (error) {
                expect(error).to.be(null);
                done()
                // rimraf(gTmpFolder, done);
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
            filesystem.backup(gBackupConfig, gBackupId_1, gSourceFolder, function (error) {
                expect(error).to.be(null);

                done();
            });
        });

        it('can restore', function (done) {
            filesystem.restore(gBackupConfig, gBackupId_1, gDestinationFolder, function (error) {
                expect(error).to.be(null);

                compareDirectories(gSourceFolder, gDestinationFolder, function (error) {
                    expect(error).to.equal(null);

                    rimraf(gDestinationFolder, done);
                });
            });
        });

        it('can copy backup', function (done) {
            // will be verified after removing the first and restoring from the copy
            filesystem.copyBackup(gBackupConfig, gBackupId_1, gBackupId_2, done);
        });

        it('can remove backup', function (done) {
            // will be verified with next test trying to restore the removed one
            filesystem.removeBackups(gBackupConfig, [ gBackupId_1 ], done);
        });

        it('cannot restore deleted backup', function (done) {
            filesystem.restore(gBackupConfig, gBackupId_1, gDestinationFolder, function (error) {
                expect(error).to.be.an('object');
                expect(error.reason).to.equal(BackupsError.NOT_FOUND);

                done();
            });
        });

        it('can restore backup copy', function (done) {
            filesystem.restore(gBackupConfig, gBackupId_2, gDestinationFolder, function (error) {
                expect(error).to.be(null);

                compareDirectories(gSourceFolder, gDestinationFolder, function (error) {
                    expect(error).to.equal(null);

                    rimraf(gDestinationFolder, done);
                });
            });
        });

        it('can remove backup copy', function (done) {
            filesystem.removeBackups(gBackupConfig, [ gBackupId_2 ], done);
        });
    });

    xdescribe('s3', function () {
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
            region: 'eu-central-1'
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
                rimraf(gTmpFolder, done);
            });
        });

        it('can backup', function (done) {
            var backupMapping = [{
                source: path.join(gSourceFolder, 'data'),
                destination: '/datadir'
            }, {
                source: path.join(gSourceFolder, 'addon'),
                destination: '/addondir/'
            }];

            s3.backup(gBackupConfig, gBackupId_1, backupMapping, function (error) {
                expect(error).to.be(null);

                done();
            });
        });

        it('can restore', function (done) {
            s3.restore(gBackupConfig, gBackupId_1, gDestinationFolder, function (error) {
                expect(error).to.be(null);

                compareDirectories(path.join(gSourceFolder, 'data'), path.join(gDestinationFolder, 'datadir'), function (error) {
                    expect(error).to.equal(null);

                    compareDirectories(path.join(gSourceFolder, 'addon'), path.join(gDestinationFolder, 'addondir'), function (error) {
                        expect(error).to.equal(null);

                        rimraf(gDestinationFolder, done);
                    });
                });
            });
        });

        it('can copy backup', function (done) {
            // will be verified after removing the first and restoring from the copy
            s3.copyBackup(gBackupConfig, gBackupId_1, gBackupId_2, done);
        });

        it('can remove backup', function (done) {
            // will be verified with next test trying to restore the removed one
            s3.removeBackups(gBackupConfig, [ gBackupId_1 ], done);
        });

        it('cannot restore deleted backup', function (done) {
            s3.restore(gBackupConfig, gBackupId_1, gDestinationFolder, function (error) {
                expect(error).to.be.an('object');
                expect(error.reason).to.equal(BackupsError.NOT_FOUND);

                done();
            });
        });

        it('can restore backup copy', function (done) {
            s3.restore(gBackupConfig, gBackupId_2, gDestinationFolder, function (error) {
                expect(error).to.be(null);

                compareDirectories(path.join(gSourceFolder, 'data'), path.join(gDestinationFolder, 'datadir'), function (error) {
                    expect(error).to.equal(null);

                    compareDirectories(path.join(gSourceFolder, 'addon'), path.join(gDestinationFolder, 'addondir'), function (error) {
                        expect(error).to.equal(null);

                        rimraf(gDestinationFolder, done);
                    });
                });
            });
        });

        it('can remove backup copy', function (done) {
            s3.removeBackups(gBackupConfig, [ gBackupId_2 ], done);
        });
    });
});
