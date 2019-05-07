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
    DataLayout = require('../datalayout.js'),
    expect = require('expect.js'),
    fs = require('fs'),
    os = require('os'),
    mkdirp = require('mkdirp'),
    path = require('path'),
    rimraf = require('rimraf'),
    settings = require('../settings.js'),
    SettingsError = require('../settings.js').SettingsError,
    tasks = require('../tasks.js');

function createBackup(callback) {
    backups.startBackupTask({ username: 'test' }, function (error, taskId) { // this call does not wait for the backup!
        if (error) return callback(error);

        function waitForBackup() {
            tasks.get(taskId, function (error, p) {
                if (error) return callback(error);

                if (p.percent !== 100) return setTimeout(waitForBackup, 1000);

                if (p.errorMessage) return callback(new Error('backup failed:' + p));
                if (!p.result) return callback(new Error('backup has no result:' + p));

                backups.getByStatePaged(backupdb.BACKUP_STATE_NORMAL, 1, 1, function (error, result) {
                    if (error) return callback(error);
                    if (result.length !== 1) return callback(new Error('result is not of length 1'));

                    callback(null, result[0]);
                });
            });
        }

        setTimeout(waitForBackup, 1000);
    });
}

function cleanupBackups(callback) {
    backups.startCleanupTask({ username: 'test' }, function (error, taskId) { // this call does not wait for the backup!
        if (error) return callback(error);

        function waitForCleanup() {
            tasks.get(taskId, function (error, p) {
                if (error) return callback(error);

                if (p.percent !== 100) return setTimeout(waitForCleanup, 1000);

                if (p.errorMessage) return callback(new Error('backup failed:' + p.errorMessage));

                callback();
            });
        }

        setTimeout(waitForCleanup, 1000);
    });
}

describe('backups', function () {
    before(function (done) {
        const BACKUP_DIR = path.join(os.tmpdir(), 'cloudron-backup-test');

        async.series([
            mkdirp.bind(null, BACKUP_DIR),
            database.initialize,
            database._clear,
            settings.setBackupConfig.bind(null, {
                provider: 'filesystem',
                key: 'enckey',
                backupFolder: BACKUP_DIR,
                retentionSecs: 1,
                format: 'tgz'
            })
        ], done);
    });

    after(function (done) {
        async.series([
            database._clear
        ], done);
    });

    describe('cleanup', function () {
        var BACKUP_0 = {
            id: 'backup-box-0',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_BOX,
            dependsOn: [ 'backup-app-00', 'backup-app-01' ],
            manifest: null,
            format: 'tgz'
        };

        var BACKUP_0_APP_0 = {
            id: 'backup-app-00',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_APP,
            dependsOn: [],
            manifest: null,
            format: 'tgz'
        };

        var BACKUP_0_APP_1 = {
            id: 'backup-app-01',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_APP,
            dependsOn: [],
            manifest: null,
            format: 'tgz'
        };

        var BACKUP_1 = {
            id: 'backup-box-1',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_BOX,
            dependsOn: [ 'backup-app-10', 'backup-app-11' ],
            manifest: null,
            format: 'tgz'
        };

        var BACKUP_1_APP_0 = {
            id: 'backup-app-10',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_APP,
            dependsOn: [],
            manifest: null,
            format: 'tgz'
        };

        var BACKUP_1_APP_1 = {
            id: 'backup-app-11',
            version: '1.0.0',
            type: backupdb.BACKUP_TYPE_APP,
            dependsOn: [],
            manifest: null,
            format: 'tgz'
        };

        it('succeeds without backups', function (done) {
            cleanupBackups(done);
        });

        it('succeeds with box backups, keeps latest', function (done) {
            async.eachSeries([[ BACKUP_0, BACKUP_0_APP_0, BACKUP_0_APP_1 ], [ BACKUP_1, BACKUP_1_APP_0, BACKUP_1_APP_1 ]], function (backup, callback) {
                // space out backups
                setTimeout(function () {
                    async.each(backup, (b, done) => backupdb.add(b.id, b, done), callback);
                }, 2000);
            }, function (error) {
                expect(error).to.not.be.ok();

                cleanupBackups(function (error) {
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
            cleanupBackups(function (error) {
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
            async.eachSeries([BACKUP_0_APP_0, BACKUP_0_APP_1], (b, done) => backupdb.add(b.id, b, done), function (error) {
                expect(error).to.not.be.ok();

                // wait for expiration
                setTimeout(function () {
                    cleanupBackups(function (error) {
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

    describe('fs meta data', function () {
        var tmpdir;
        before(function () {
            tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'backups-test'));
        });
        after(function () {
            rimraf.sync(tmpdir);
        });

        it('saves special files', function (done) {
            createTree(tmpdir, { 'data': { 'subdir': { 'emptydir': { } } }, 'dir2': { 'file': 'stuff' } });
            fs.chmodSync(path.join(tmpdir, 'dir2/file'), parseInt('0755', 8));

            let dataLayout = new DataLayout(tmpdir, []);

            backups._saveFsMetadata(dataLayout, `${dataLayout.localRoot()}/fsmetadata.json`, function (error) {
                expect(error).to.not.be.ok();

                var emptyDirs = JSON.parse(fs.readFileSync(path.join(tmpdir, 'fsmetadata.json'), 'utf8')).emptyDirs;
                expect(emptyDirs).to.eql(['./data/subdir/emptydir']);

                var execFiles = JSON.parse(fs.readFileSync(path.join(tmpdir, 'fsmetadata.json'), 'utf8')).execFiles;
                expect(execFiles).to.eql(['./dir2/file']);

                done();
            });
        });

        it('restores special files', function (done) {
            rimraf.sync(path.join(tmpdir, 'data'));

            expect(fs.existsSync(path.join(tmpdir, 'data/subdir/emptydir'))).to.be(false); // just make sure rimraf worked

            let dataLayout = new DataLayout(tmpdir, []);

            backups._restoreFsMetadata(dataLayout, `${dataLayout.localRoot()}/fsmetadata.json`, function (error) {
                expect(error).to.not.be.ok();

                expect(fs.existsSync(path.join(tmpdir, 'data/subdir/emptydir'))).to.be(true);
                var mode = fs.statSync(path.join(tmpdir, 'dir2/file')).mode;
                expect(mode & ~fs.constants.S_IFREG).to.be(parseInt('0755', 8));

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
            // arch only has maria db which lacks some mysqldump options we need, this is only here to allow running the tests :-/
            if (require('child_process').execSync('/usr/bin/mysqldump --version').toString().indexOf('MariaDB') !== -1) done();

            createBackup(function (error, result) {
                expect(error).to.be(null);
                expect(fs.statSync(path.join(gBackupConfig.backupFolder, 'snapshot/box.tar.gz')).nlink).to.be(2); // hard linked to a rotated backup
                expect(fs.statSync(path.join(gBackupConfig.backupFolder, `${result.id}.tar.gz`)).nlink).to.be(2);

                backupInfo1 = result;

                done();
            });
        });

        it('can take another backup', function (done) {
            // arch only has maria db which lacks some mysqldump options we need, this is only here to allow running the tests :-/
            if (require('child_process').execSync('/usr/bin/mysqldump --version').toString().indexOf('MariaDB') !== -1) done();

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
