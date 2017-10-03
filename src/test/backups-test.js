/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    backupdb = require('../backupdb.js'),
    backups = require('../backups.js'),
    createTree = require('./common.js').createTree,
    database = require('../database'),
    DatabaseError = require('../databaseerror.js'),
    expect = require('expect.js'),
    fs = require('fs'),
    os = require('os'),
    mkdirp = require('mkdirp'),
    readdirp = require('readdirp'),
    path = require('path'),
    progress = require('../progress.js'),
    rimraf = require('rimraf'),
    settings = require('../settings.js'),
    SettingsError = require('../settings.js').SettingsError;

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

function createBackup(callback) {
    backups.backup({ username: 'test' }, function (error) { // this call does not wait for the backup!
        if (error) return callback(error);

        function waitForBackup() {
            var p = progress.getAll();
            if (p.backup.percent !== 100) return setTimeout(waitForBackup, 1000);

            if (p.backup.message) return callback(new Error('backup failed:' + p.backup.message));

            backups.getByStatePaged(backupdb.BACKUP_STATE_NORMAL, 1, 1, function (error, result) {
                if (error) return callback(error);
                if (result.length !== 1) return callback(new Error('result is not of length 1'));

                callback(null, result[0]);
            });
        }

        setTimeout(waitForBackup, 1000);
    });
}

describe('backups', function () {
    before(function (done) {
        async.series([
            database.initialize,
            database._clear,
            settings.initialize,
            settings.setBackupConfig.bind(null, {
                provider: 'filesystem',
                key: 'enckey',
                backupFolder: '/var/backups',
                retentionSecs: 1,
                format: 'tgz'
            })
        ], done);
    });

    after(function (done) {
        async.series([
            settings.uninitialize,
            database._clear
        ], done);
    });

    describe('cleanup', function () {
        this.timeout(20000);

        var BACKUP_0 = {
            id: 'backup-box-0',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_BOX,
            dependsOn: [ 'backup-app-00', 'backup-app-01' ],
            restoreConfig: null,
            format: 'tgz'
        };

        var BACKUP_0_APP_0 = {
            id: 'backup-app-00',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_APP,
            dependsOn: [],
            restoreConfig: null,
            format: 'tgz'
        };

        var BACKUP_0_APP_1 = {
            id: 'backup-app-01',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_APP,
            dependsOn: [],
            restoreConfig: null,
            format: 'tgz'
        };

        var BACKUP_1 = {
            id: 'backup-box-1',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_BOX,
            dependsOn: [ 'backup-app-10', 'backup-app-11' ],
            restoreConfig: null,
            format: 'tgz'
        };

        var BACKUP_1_APP_0 = {
            id: 'backup-app-10',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_APP,
            dependsOn: [],
            restoreConfig: null,
            format: 'tgz'
        };

        var BACKUP_1_APP_1 = {
            id: 'backup-app-11',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_APP,
            dependsOn: [],
            restoreConfig: null,
            format: 'tgz'
        };

        it('succeeds without backups', function (done) {
            backups.cleanup({ username: 'test' }, done);
        });

        it('succeeds with box backups, keeps latest', function (done) {
            async.eachSeries([[ BACKUP_0, BACKUP_0_APP_0, BACKUP_0_APP_1 ], [ BACKUP_1, BACKUP_1_APP_0, BACKUP_1_APP_1 ]], function (backup, callback) {
                // space out backups
                setTimeout(function () {
                    async.each(backup, backupdb.add, callback);
                }, 2000);
            }, function (error) {
                expect(error).to.not.be.ok();

                backups.cleanup({ username: 'test' }, function (error) {
                    expect(error).to.not.be.ok();

                    backupdb.getByTypePaged(backupdb.BACKUP_TYPE_BOX, 1, 1000, function (error, result) {
                        expect(error).to.not.be.ok();
                        expect(result.length).to.equal(1);
                        expect(result[0].id).to.equal(BACKUP_1.id);

                        // check that app backups are gone as well
                        backupdb.get(BACKUP_0_APP_0.id, function (error) {
                            expect(error).to.be.a(DatabaseError);
                            expect(error.reason).to.equal(DatabaseError.NOT_FOUND);

                            done();
                        });
                    });
                });
            });
        });

        it('does not remove expired backups if only one left', function (done) {
            backups.cleanup({ username: 'test' }, function (error) {
                expect(error).to.not.be.ok();

                backupdb.getByTypePaged(backupdb.BACKUP_TYPE_BOX, 1, 1000, function (error, result) {
                    expect(error).to.not.be.ok();
                    expect(result.length).to.equal(1);
                    expect(result[0].id).to.equal(BACKUP_1.id);

                    // check that app backups are also still there
                    backupdb.get(BACKUP_1_APP_0.id, function (error, result) {
                        expect(error).to.not.be.ok();
                        expect(result.id).to.equal(BACKUP_1_APP_0.id);

                        done();
                    });
                });
            });
        });

        it('succeeds for app backups not referenced by a box backup', function (done) {
            async.eachSeries([BACKUP_0_APP_0, BACKUP_0_APP_1], backupdb.add, function (error) {
                expect(error).to.not.be.ok();

                // wait for expiration
                setTimeout(function () {
                    backups.cleanup({ username: 'test' }, function (error) {
                        expect(error).to.not.be.ok();

                        backupdb.getByTypePaged(backupdb.BACKUP_TYPE_APP, 1, 1000, function (error, result) {
                            expect(error).to.not.be.ok();
                            expect(result.length).to.equal(2);

                            done();
                        });
                    });
                }, 2000);
            });
        });
    });

    describe('empty dirs', function () {
        var tmpdir;
        before(function () {
            tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'backups-test'));
        });
        after(function () {
            rimraf.sync(tmpdir);
        });

        it('saves empty dirs file', function (done) {
            createTree(tmpdir, { 'data': { 'subdir': { 'emptydir': { } } }, 'dir2': { 'file': 'stuff' } });

            backups._saveEmptyDirs(tmpdir, function (error) {
                expect(error).to.not.be.ok();

                var emptyDirs = fs.readFileSync(path.join(tmpdir, 'emptydirs.txt'), 'utf8').trim().split('\n');
                expect(emptyDirs).to.eql(['./data/subdir/emptydir']);

                done();
            });
        });

        it('creates empty dirs file', function (done) {
            rimraf.sync(path.join(tmpdir, 'data'));

            expect(fs.existsSync(path.join(tmpdir, 'data/subdir/emptydir'))).to.be(false); // just make sure rimraf worked

            backups._createEmptyDirs(tmpdir, function (error) {
                expect(error).to.not.be.ok();

                expect(fs.existsSync(path.join(tmpdir, 'data/subdir/emptydir'))).to.be(true);

                done();
            });
        });
    });

    describe('filesystem', function () {
        var backupInfo1;

        var gBackupConfig = {
            provider: 'filesystem',
            backupFolder: path.join(os.tmpdir(), 'backups-test-filesystem'),
            format: 'tgz'
        };

        before(function (done) {
            rimraf.sync(gBackupConfig.backupFolder);

            done();
        });

        after(function (done) {
            rimraf.sync(gBackupConfig.backupFolder);
            progress.clear(progress.BACKUP);
            done();
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
            this.timeout(6000);

            createBackup(function (error, result) {
                expect(error).to.be(null);
                expect(fs.statSync(path.join(gBackupConfig.backupFolder, 'snapshot/box.tar.gz')).nlink).to.be(2); // hard linked to a rotated backup
                expect(fs.statSync(path.join(gBackupConfig.backupFolder, `${result.id}.tar.gz`)).nlink).to.be(2);

                backupInfo1 = result;

                done();
            });
        });

        it('can take another backup', function (done) {
            this.timeout(6000);

            createBackup(function (error, result) {
                expect(error).to.be(null);
                expect(fs.statSync(path.join(gBackupConfig.backupFolder, 'snapshot/box.tar.gz')).nlink).to.be(2); // hard linked to a rotated backup
                expect(fs.statSync(path.join(gBackupConfig.backupFolder, `${result.id}.tar.gz`)).nlink).to.be(2); // hard linked to new backup
                expect(fs.statSync(path.join(gBackupConfig.backupFolder, `${backupInfo1.id}.tar.gz`)).nlink).to.be(1); // not hard linked anymore

                done();
            });
        });
    });
});
