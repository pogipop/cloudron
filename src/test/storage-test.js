/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var BackupsError = require('../backups.js').BackupsError,
    execSync = require('child_process').execSync,
    expect = require('expect.js'),
    filesystem = require('../storage/filesystem.js'),
    fs = require('fs'),
    MockS3 = require('mock-aws-s3'),
    noop = require('../storage/noop.js'),
    os = require('os'),
    path = require('path'),
    rimraf = require('rimraf'),
    mkdirp = require('mkdirp'),
    recursive_readdir = require('recursive-readdir'),
    s3 = require('../storage/s3.js'),
    gcs = require('../storage/gcs.js'),
    chunk = require('lodash.chunk');

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

        it('list dir lists the source dir', function (done) {
            var sourceDir = path.join(__dirname, 'storage');

            var allFiles = [ ];
            filesystem.listDir(gBackupConfig, sourceDir, 1, function (files, iteratorCallback) {
                allFiles = allFiles.concat(files);
                iteratorCallback();
            }, function () {
                var expectedFiles = execSync(`find ${sourceDir} -type f`, { encoding: 'utf8' }).trim().split('\n');
                expect(allFiles.map(function (f) { return f.fullPath; }).sort()).to.eql(expectedFiles.sort());

                done();
            });
        });

        it('can copy', function (done) {
            var sourceFile = gTmpFolder + '/uploadtest/test.txt'; // keep the test within save device
            var destFile = gTmpFolder + '/uploadtest/test-hardlink.txt';

            var events = filesystem.copy(gBackupConfig, sourceFile, destFile);
            events.on('done', function (error) {
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

        it('list dir contents of source dir', function (done) {
            noop.listDir(gBackupConfig, 'sourceDir', 1000, function (files, iteratorDone) {
                iteratorDone();
            }, done);
        });

        it('can copy', function (done) {
            var events = noop.copy(gBackupConfig, 'sourceFile', 'destFile');
            events.on('done', function (error) {
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

        it('list dir lists contents of source dir', function (done) {
            var allFiles = [ ];
            s3.listDir(gBackupConfig, '', 1, function (files, iteratorCallback) {
                allFiles = allFiles.concat(files);
                iteratorCallback();
            }, function () {
                expect(allFiles.map(function (f) { return f.fullPath; }).sort()).to.eql([ 'uploadtest/test.txt' ]);

                done();
            });
        });

        it('can copy', function (done) {
            fs.writeFileSync(path.join(gS3Folder, 'uploadtest/C++.gitignore'), 'special', 'utf8');

            var sourceKey = 'uploadtest';

            var events = s3.copy(gBackupConfig, sourceKey, 'uploadtest-copy');
            events.on('done', function (error) {
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

    describe('gcs', function () {
        var gBackupConfig = {
            provider: 'gcs',
            key: '',
            prefix: 'unit.test',
            bucket: 'cloudron-storage-test',
            projectId: '',
            credentials: {
                client_email: '',
                private_key: ''
            }
        };
        var GCSMockBasePath = path.join(os.tmpdir(), 'gcs-backup-test-buckets/');

        before(function () {
            var mockGCS = function(cfg){
                return {bucket: function(b){
                    var file = function(filename){

                        var ensurePathWritable = function (filename) {
                            filename = GCSMockBasePath + filename;
                            mkdirp.sync(path.dirname(filename));
                            return filename;
                        };

                        return {
                            name: filename,
                            createReadStream: function(cfg){
                                return fs.createReadStream(ensurePathWritable(filename))
                                    .on('error', function(e){
                                        console.log('error createReadStream: '+filename);
                                        if (e.code == 'ENOENT') { e.code = 404; }
                                        this.emit('error', e);
                                    })
                                ;
                            },
                            createWriteStream: function(cfg){
                                return fs.createWriteStream(ensurePathWritable(filename));
                            },
                            delete: function(cb){
                                fs.unlink(ensurePathWritable(filename), cb);
                            },
                            copy: function(dst, cb){
                                var notFoundHandler = function(e){
                                    if (e && e.code == 'ENOENT') { e.code = 404; return cb(e);}
                                    cb();
                                };
                                return fs.createReadStream(ensurePathWritable(filename))
                                    .on('end', cb)
                                    .on('error', notFoundHandler)
                                    .pipe(fs.createWriteStream(ensurePathWritable(dst)))
                                    .on('end', cb)
                                    .on('error', notFoundHandler)
                                ;
                            }
                        };
                    };

                    return {
                        file: file,
                        getFiles: function(q, cb){
                            var target = GCSMockBasePath + q.prefix;
                            recursive_readdir(target, function(e, files){

                                var pageToken = q.pageToken || 0;

                                var chunkedFiles = chunk(files, q.maxResults);
                                if (q.pageToken >= chunkedFiles.length) return cb(null, []);

                                var gFiles = chunkedFiles[pageToken].map(function(f){
                                    return file(path.relative(GCSMockBasePath, f)); //convert to google
                                });

                                q.pageToken = pageToken + 1;
                                cb(null, gFiles, q.pageToken < chunkedFiles.length ? q : null);
                            });
                        }
                    };
                }};
            };
            gcs._mockInject(mockGCS);
        });

        after(function (done) {
            gcs._mockRestore();
            rimraf.sync(GCSMockBasePath);
            done();
        });

        it('can backup', function (done) {
            var sourceFile = path.join(__dirname, 'storage/data/test.txt');
            var sourceStream = fs.createReadStream(sourceFile);
            var destKey = 'uploadtest/test.txt';
            gcs.upload(gBackupConfig, destKey, sourceStream, function (error) {
                expect(error).to.be(null);

                done();
            });
        });

        it('can download file', function (done) {
            var sourceKey = 'uploadtest/test.txt';
            gcs.download(gBackupConfig, sourceKey, function (error, stream) {
                expect(error).to.be(null);
                expect(stream).to.be.an('object');
                done();
            });
        });

        it('list dir lists contents of source dir', function (done) {
            var allFiles = [ ];
            gcs.listDir(gBackupConfig, '', 1, function (files, iteratorCallback) {
                allFiles = allFiles.concat(files);
                iteratorCallback();
            }, function () {
                expect(allFiles.map(function (f) { return f.fullPath; }).sort()).to.eql([ 'uploadtest/test.txt' ]);

                done();
            });
        });

        xit('can copy', function (done) {
            fs.writeFileSync(path.join(GCSMockBasePath, 'uploadtest/C++.gitignore'), 'special', 'utf8');

            var sourceKey = 'uploadtest';

            var events = gcs.copy(gBackupConfig, sourceKey, 'uploadtest-copy');
            events.on('done', function (error) {
                var sourceFile = path.join(__dirname, 'storage/data/test.txt');
                expect(error).to.be(null);
                expect(fs.statSync(path.join(GCSMockBasePath, 'uploadtest-copy/test.txt')).size).to.be(fs.statSync(sourceFile).size);

                expect(fs.statSync(path.join(GCSMockBasePath, 'uploadtest-copy/C++.gitignore')).size).to.be(7);

                done();
            });
        });

        it('can remove file', function (done) {
            gcs.remove(gBackupConfig, 'uploadtest-copy/test.txt', function (error) {
                expect(error).to.be(null);
                expect(fs.existsSync(path.join(GCSMockBasePath, 'uploadtest-copy/test.txt'))).to.be(false);
                done();
            });
        });

        it('can remove non-existent dir', function (done) {
            gcs.remove(gBackupConfig, 'blah', function (error) {
                expect(error).to.be(null);
                done();
            });
        });

    });
});
