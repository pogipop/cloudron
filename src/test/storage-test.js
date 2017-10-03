/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var BackupsError = require('../backups.js').BackupsError,
    expect = require('expect.js'),
    filesystem = require('../storage/filesystem.js'),
    fs = require('fs'),
    MockS3 = require('mock-aws-s3'),
    noop = require('../storage/noop.js'),
    os = require('os'),
    path = require('path'),
    rimraf = require('rimraf'),
    s3 = require('../storage/s3.js');

describe('Storage', function () {
    describe('filesystem', function () {

        var gTmpFolder;

        var gBackupConfig = {
            provider: 'filesystem',
            key: 'key',
            backupFolder: null,
            format: 'tgz'
        };

        before(function (done) {
            gTmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'filesystem-storage-test_'));

            gBackupConfig.backupFolder = path.join(gTmpFolder, 'backups/');

            done();
        });

        after(function (done) {
            rimraf.sync(gTmpFolder);
            done();
        });

        it('can upload', function (done) {
            var sourceFile = path.join(__dirname, 'storage/data/test.txt');
            var sourceStream = fs.createReadStream(sourceFile);
            var destFile = gTmpFolder + '/uploadtest/test.txt';
            filesystem.upload(gBackupConfig, destFile, sourceStream, function (error) {
                expect(error).to.be(null);
                expect(fs.existsSync(destFile));
                expect(fs.statSync(sourceFile).size).to.be(fs.statSync(destFile).size);
                done();
            });
        });

        it('upload waits for empty file to be created', function (done) {
            var sourceFile = path.join(__dirname, 'storage/data/empty');
            var sourceStream = fs.createReadStream(sourceFile);
            var destFile = gTmpFolder + '/uploadtest/empty';
            filesystem.upload(gBackupConfig, destFile, sourceStream, function (error) {
                expect(error).to.be(null);
                expect(fs.existsSync(destFile));
                expect(fs.statSync(sourceFile).size).to.be(fs.statSync(destFile).size);
                done();
            });
        });

        it('upload unlinks old file', function (done) {
            var sourceFile = path.join(__dirname, 'storage/data/test.txt');
            var sourceStream = fs.createReadStream(sourceFile);
            var destFile = gTmpFolder + '/uploadtest/test.txt';
            var oldStat = fs.statSync(destFile);
            filesystem.upload(gBackupConfig, destFile, sourceStream, function (error) {
                expect(error).to.be(null);
                expect(fs.existsSync(destFile)).to.be(true);
                expect(fs.statSync(sourceFile).size).to.be(fs.statSync(destFile).size);
                expect(oldStat.inode).to.not.be(fs.statSync(destFile).size);
                done();
            });
        });

        it('can download file', function (done) {
            var sourceFile = gTmpFolder + '/uploadtest/test.txt';

            filesystem.download(gBackupConfig, sourceFile, function (error, stream) {
                expect(error).to.be(null);
                expect(stream).to.be.an('object');
                done();
            });
        });

        it('download errors for missing file', function (done) {
            var sourceFile = gTmpFolder + '/uploadtest/missing';

            filesystem.download(gBackupConfig, sourceFile, function (error) {
                expect(error.reason).to.be(BackupsError.NOT_FOUND);
                done();
            });
        });

        it('download dir copies contents of source dir', function (done) {
            var sourceDir = path.join(__dirname, 'storage');

            filesystem.downloadDir(gBackupConfig, sourceDir, gTmpFolder, function (error) {
                expect(error).to.be(null);
                expect(fs.statSync(path.join(gTmpFolder, 'data/empty')).size).to.be(0);
                done();
            });
        });

        it('can copy', function (done) {
            var sourceFile = gTmpFolder + '/uploadtest/test.txt'; // keep the test within save device
            var destFile = gTmpFolder + '/uploadtest/test-hardlink.txt';

            filesystem.copy(gBackupConfig, sourceFile, destFile, function (error) {
                expect(error).to.be(null);
                expect(fs.statSync(destFile).nlink).to.be(2); // created a hardlink
                done();
            });
        });

        it('can remove file', function (done) {
            var sourceFile = gTmpFolder + '/uploadtest/test-hardlink.txt';

            filesystem.remove(gBackupConfig, sourceFile, function (error) {
                expect(error).to.be(null);
                expect(fs.existsSync(sourceFile)).to.be(false);
                done();
            });
        });

        it('can remove empty dir', function (done) {
            var sourceDir = gTmpFolder + '/emptydir';
            fs.mkdirSync(sourceDir);

            filesystem.remove(gBackupConfig, sourceDir, function (error) {
                expect(error).to.be(null);
                expect(fs.existsSync(sourceDir)).to.be(false);
                done();
            });
        });
    });

    describe('noop', function () {
        var gBackupConfig = {
            provider: 'noop',
            format: 'tgz'
        };

        it('upload works', function (done) {
            noop.upload(gBackupConfig, 'file', { }, function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can download file', function (done) {
            noop.download(gBackupConfig, 'file', function (error) {
                expect(error).to.be.an(Error);
                done();
            });
        });

        it('download dir copies contents of source dir', function (done) {
            noop.downloadDir(gBackupConfig, 'sourceDir', 'destDir', function (error) {
                expect(error).to.be.an(Error);
                done();
            });
        });

        it('can copy', function (done) {
            noop.copy(gBackupConfig, 'sourceFile', 'destFile', function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can remove file', function (done) {
            noop.remove(gBackupConfig, 'sourceFile', function (error) {
                expect(error).to.be(null);
                done();
            });
        });

        it('can remove empty dir', function (done) {
            noop.remove(gBackupConfig, 'sourceDir', function (error) {
                expect(error).to.be(null);
                done();
            });
        });
    });

    describe('s3', function () {
        this.timeout(10000);

        var gS3Folder;
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

        before(function () {
            MockS3.config.basePath = path.join(os.tmpdir(), 's3-backup-test-buckets/');
            rimraf.sync(MockS3.config.basePath);
            gS3Folder = path.join(MockS3.config.basePath, gBackupConfig.bucket);

            s3._mockInject(MockS3);
        });

        after(function () {
            s3._mockRestore();
            rimraf.sync(MockS3.config.basePath);
        });

        it('can upload', function (done) {
            var sourceFile = path.join(__dirname, 'storage/data/test.txt');
            var sourceStream = fs.createReadStream(sourceFile);
            var destKey = 'uploadtest/test.txt';
            s3.upload(gBackupConfig, destKey, sourceStream, function (error) {
                expect(error).to.be(null);
                expect(fs.existsSync(path.join(gS3Folder, destKey))).to.be(true);
                expect(fs.statSync(path.join(gS3Folder, destKey)).size).to.be(fs.statSync(sourceFile).size);
                done();
            });
        });

        it('can download file', function (done) {
            var sourceKey = 'uploadtest/test.txt';
            s3.download(gBackupConfig, sourceKey, function (error, stream) {
                expect(error).to.be(null);
                expect(stream).to.be.an('object');
                done();
            });
        });

        it('download dir copies contents of source dir', function (done) {
            var sourceFile = path.join(__dirname, 'storage/data/test.txt');
            var sourceKey = '';
            var destDir = path.join(os.tmpdir(), 's3-destdir');

            s3.downloadDir(gBackupConfig, sourceKey, destDir, function (error) {
                expect(error).to.be(null);
                expect(fs.statSync(path.join(destDir, 'uploadtest/test.txt')).size).to.be(fs.statSync(sourceFile).size);
                done();
            });
        });

        it('can copy', function (done) {
            fs.writeFileSync(path.join(gS3Folder, 'uploadtest/C++.gitignore'), 'special', 'utf8');

            var sourceKey = 'uploadtest';

            s3.copy(gBackupConfig, sourceKey, 'uploadtest-copy', function (error) {
                var sourceFile = path.join(__dirname, 'storage/data/test.txt');
                expect(error).to.be(null);
                expect(fs.statSync(path.join(gS3Folder, 'uploadtest-copy/test.txt')).size).to.be(fs.statSync(sourceFile).size);

                expect(fs.statSync(path.join(gS3Folder, 'uploadtest-copy/C++.gitignore')).size).to.be(7);

                done();
            });
        });

        it('can remove file', function (done) {
            s3.remove(gBackupConfig, 'uploadtest-copy/test.txt', function (error) {
                expect(error).to.be(null);
                expect(fs.existsSync(path.join(gS3Folder, 'uploadtest-copy/test.txt'))).to.be(false);
                done();
            });
        });

        it('can remove non-existent dir', function (done) {
            noop.remove(gBackupConfig, 'blah', function (error) {
                expect(error).to.be(null);
                done();
            });
        });
    });
});
