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
    rimraf = require('rimraf'),
    BackupsError = require('../backups.js').BackupsError,
    config = require('../config.js'),
    database = require('../database.js'),
    caas = require('../storage/caas.js'),
    s3 = require('../storage/s3.js'),
    filesystem = require('../storage/filesystem.js'),
    expect = require('expect.js'),
    settings = require('../settings.js');

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

                settings.setBackupConfig(gBackupConfig, function (error) {
                    expect(error).to.be(null);

                    done();
                });
            });
        });
        
        after(function (done) {
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

            filesystem.backup(gBackupConfig, gBackupId_1, backupMapping, function (error) {
                expect(error).to.be(null);

                done();
            });
        });

        it('can restore', function (done) {
            var restoreMapping = [{
                source: '/datadir',
                destination: path.join(gDestinationFolder, 'data')
            }, {
                source: '/addondir',
                destination: path.join(gDestinationFolder, 'addon')
            }];

            filesystem.restore(gBackupConfig, gBackupId_1, restoreMapping, function (error) {
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
            filesystem.removeBackup(gBackupConfig, gBackupId_1, [], done);
        });

        it('cannot restore deleted backup', function (done) {
            var restoreMapping = [{
                source: '/datadir',
                destination: path.join(gDestinationFolder, 'data')
            }];

            filesystem.restore(gBackupConfig, gBackupId_1, restoreMapping, function (error) {
                expect(error).to.be.an('object');
                expect(error.reason).to.equal(BackupsError.NOT_FOUND);

                done();
            });
        });

        it('can restore backup copy', function (done) {
            var restoreMapping = [{
                source: '/datadir',
                destination: path.join(gDestinationFolder, 'data')
            }, {
                source: '/addondir',
                destination: path.join(gDestinationFolder, 'addon')
            }];

            filesystem.restore(gBackupConfig, gBackupId_2, restoreMapping, function (error) {
                expect(error).to.be(null);

                rimraf(gDestinationFolder, done);
            });
        });

        it('cannot get backup download stream from deleted backup', function (done) {
            filesystem.getDownloadStream(gBackupConfig, gBackupId_1, function (error) {
                expect(error).to.be.an('object');
                expect(error.reason).to.equal(BackupsError.NOT_FOUND);
                done();
            });
        });

        it('can get backup download stream', function (done) {
            filesystem.getDownloadStream(gBackupConfig, gBackupId_2, function (error, result) {
                expect(error).to.be(null);
                expect(result).to.be.a(fs.ReadStream);
                done();
            })
        });

        it('can remove backup copy', function (done) {
            filesystem.removeBackup(gBackupConfig, gBackupId_2, [], done);
        });
    });
});
