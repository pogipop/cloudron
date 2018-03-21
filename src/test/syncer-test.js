/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var createTree = require('./common.js').createTree,
    execSync = require('child_process').execSync,
    expect = require('expect.js'),
    fs = require('fs'),
    os = require('os'),
    path = require('path'),
    paths = require('../paths.js'),
    safe = require('safetydance'),
    syncer = require('../syncer.js');

var gTasks = [ ],
    gTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncer-test')),
    gCacheFile = path.join(paths.BACKUP_INFO_DIR, path.basename(gTmpDir) + '.sync.cache');

function collectTasks(task, callback) {
    gTasks.push(task);
    callback();
}

describe('Syncer', function () {
    before(function () {
        console.log('Tests are run in %s with cache file %s', gTmpDir, gCacheFile)
    });

    it('missing cache - removes remote dir', function (done) {
        gTasks = [ ];
        safe.fs.unlinkSync(gCacheFile);
        createTree(gTmpDir, { });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();

            expect(gTasks).to.eql([
                { operation: 'removedir', path: '', reason: 'nocache' }
            ]);
            done();
        });
    });

    it('empty cache - adds all', function (done) {
        gTasks = [ ];
        fs.writeFileSync(gCacheFile, '', 'utf8');
        createTree(gTmpDir, { 'src': { 'index.js': 'some code' }, 'test': { 'test.js': 'This is a README' }, 'walrus': 'animal' });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();

            expect(gTasks).to.eql([
                { operation: 'add', path: 'src/index.js', reason: 'new', position: 0 },
                { operation: 'add', path: 'test/test.js', reason: 'new', position: 1 },
                { operation: 'add', path: 'walrus', reason: 'new', position: 2 }
            ]);
            done();
        });
    });

    it('empty cache - deep', function (done) {
        gTasks = [ ];
        fs.writeFileSync(gCacheFile, '', 'utf8');
        createTree(gTmpDir, { a: { b: { c: { d: { e: 'some code' } } } } });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();

            expect(gTasks).to.eql([
                { operation: 'add', path: 'a/b/c/d/e', reason: 'new', position: 0 }
            ]);
            done();
        });
    });

    it('ignores special files', function (done) {
        gTasks = [ ];
        fs.writeFileSync(gCacheFile, '', 'utf8');
        createTree(gTmpDir, { 'link:file': '/tmp', 'readme': 'this is readme' });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();

            expect(gTasks).to.eql([
                { operation: 'add', path: 'readme', reason: 'new', position: 0 }
            ]);
            done();
        });
    });

    it('adds changed files', function (done) {
        gTasks = [ ];
        fs.writeFileSync(gCacheFile, '', 'utf8');
        createTree(gTmpDir, { 'src': { 'index.js': 'some code' }, 'test': { 'test.js': 'This is a README' }, 'walrus': 'animal' });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();
            expect(gTasks.length).to.be(3);

            execSync(`touch src/index.js test/test.js`, { cwd: gTmpDir });

            gTasks = [ ];
            syncer.sync(gTmpDir, collectTasks, 10, function (error) {
                expect(error).to.not.be.ok();

                expect(gTasks).to.eql([
                    { operation: 'add', path: 'src/index.js', reason: 'changed', position: 0 },
                    { operation: 'add', path: 'test/test.js', reason: 'changed', position: 1 }
                ]);

                done();
            });
        });
    });

    it('removes missing files', function (done) {
        gTasks = [ ];
        fs.writeFileSync(gCacheFile, '', 'utf8');
        createTree(gTmpDir, { 'src': { 'index.js': 'some code' }, 'test': { 'test.js': 'This is a README' }, 'walrus': 'animal' });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();
            expect(gTasks.length).to.be(3);

            execSync(`rm src/index.js walrus`, { cwd: gTmpDir });

            gTasks = [ ];
            syncer.sync(gTmpDir, collectTasks, 10, function (error) {
                expect(error).to.not.be.ok();

                expect(gTasks).to.eql([
                    { operation: 'remove', path: 'src/index.js', reason: 'missing' },
                    { operation: 'remove', path: 'walrus', reason: 'missing' }
                ]);

                done();
            });
        });
    });

    it('removes missing dirs', function (done) {
        gTasks = [ ];
        fs.writeFileSync(gCacheFile, '', 'utf8');
        createTree(gTmpDir, { 'src': { 'index.js': 'some code' }, 'test': { 'test.js': 'This is a README' }, 'walrus': 'animal' });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();
            expect(gTasks.length).to.be(3);

            execSync(`rm -rf src test`, { cwd: gTmpDir });

            gTasks = [ ];
            syncer.sync(gTmpDir, collectTasks, 10, function (error) {
                expect(error).to.not.be.ok();

                expect(gTasks).to.eql([
                    { operation: 'removedir', path: 'src', reason: 'missing' },
                    { operation: 'removedir', path: 'test', reason: 'missing' }
                ]);

                done();
            });
        });
    });

    it('all files disappeared', function (done) {
        gTasks = [ ];
        fs.writeFileSync(gCacheFile, '', 'utf8');
        createTree(gTmpDir, { 'src': { 'index.js': 'some code' }, 'test': { 'test.js': 'This is a README' }, 'walrus': 'animal' });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();
            expect(gTasks.length).to.be(3);

            execSync(`find . -delete`, { cwd: gTmpDir });

            gTasks = [ ];
            syncer.sync(gTmpDir, collectTasks, 10, function (error) {
                expect(error).to.not.be.ok();

                expect(gTasks).to.eql([
                    { operation: 'removedir', path: 'src', reason: 'missing' },
                    { operation: 'removedir', path: 'test', reason: 'missing' },
                    { operation: 'remove', path: 'walrus', reason: 'missing' }
                ]);

                done();
            });
        });
    });

    it('no redundant deletes', function (done) {
        gTasks = [ ];
        fs.writeFileSync(gCacheFile, '', 'utf8');
        createTree(gTmpDir, { a: { b: { c: { d: { e: 'some code' } } } } });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();
            expect(gTasks.length).to.be(1);

            execSync(`rm -r a/b; touch a/f`, { cwd: gTmpDir });

            gTasks = [ ];
            syncer.sync(gTmpDir, collectTasks, 10, function (error) {
                expect(error).to.not.be.ok();

                expect(gTasks).to.eql([
                    { operation: 'removedir', path: 'a/b', reason: 'missing' },
                    { operation: 'add', path: 'a/f', reason: 'new', position: 0 }
                ]);

                done();
            });
        });
    });

    it('file became dir', function (done) {
        gTasks = [ ];
        fs.writeFileSync(gCacheFile, '', 'utf8');
        createTree(gTmpDir, { 'data': { 'src': { 'index.js': 'some code' }, 'test': { 'test.js': 'This is a README' }, 'walrus': 'animal' } });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();
            expect(gTasks.length).to.be(3);

            execSync(`rm data/test/test.js; mkdir data/test/test.js; touch data/test/test.js/trick`, { cwd: gTmpDir });

            gTasks = [ ];
            syncer.sync(gTmpDir, collectTasks, 10, function (error) {
                expect(error).to.not.be.ok();

                expect(gTasks).to.eql([
                    { operation: 'remove', path: 'data/test/test.js', reason: 'wasfile' },
                    { operation: 'add', path: 'data/test/test.js/trick', reason: 'new', position: 0 }
                ]);

                done();
            });
        });
    });

    it('dir became file', function (done) {
        gTasks = [ ];
        fs.writeFileSync(gCacheFile, '', 'utf8');
        createTree(gTmpDir, { 'src': { 'index.js': 'some code' }, 'test': { 'test.js': 'this', 'test2.js': 'test' }, 'walrus': 'animal' });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();
            expect(gTasks.length).to.be(4);

            execSync(`rm -r test; touch test`, { cwd: gTmpDir });

            gTasks = [ ];
            syncer.sync(gTmpDir, collectTasks, 10, function (error) {
                expect(error).to.not.be.ok();

                expect(gTasks).to.eql([
                    { operation: 'removedir', path: 'test', reason: 'wasdir' },
                    { operation: 'add', path: 'test', reason: 'wasdir', position: 0 }
                ]);

                done();
            });
        });
    });

    it('is complicated', function (done) {
        gTasks = [ ];
        createTree(gTmpDir, {
            a: 'data',
            a2: 'data',
            b: 'data',
            file: 'data',
            g: {
                file: 'data'
            },
            j: {
                k: { },
                l: {
                    file: 'data'
                },
                m: { }
            }
        });

        syncer.sync(gTmpDir, collectTasks, 10, function (error) {
            expect(error).to.not.be.ok();

            execSync(`rm a; \
                      mkdir a; \
                      touch a/file; \
                      rm a2; \
                      touch b; \
                      rm file g/file; \
                      ln -s /tmp h; \
                      rm -r j/l;
                      touch j/k/file; \
                      rmdir j/m;`, { cwd: gTmpDir });

            gTasks = [ ];
            syncer.sync(gTmpDir, collectTasks, 10, function (error) {
                expect(error).to.not.be.ok();

                expect(gTasks).to.eql([
                    { operation: 'remove', path: 'a', reason: 'wasfile' },
                    { operation: 'remove', path: 'a2', reason: 'missing' },
                    { operation: 'remove', path: 'file', reason: 'missing' },
                    { operation: 'remove', path: 'g/file', reason: 'missing' },
                    { operation: 'removedir', path: 'j/l', reason: 'missing' },
                    { operation: 'removedir', path: 'j/m', reason: 'missing' },

                    { operation: 'add', path: 'a/file', reason: 'new', position: 0 },
                    { operation: 'add', path: 'b', reason: 'changed', position: 1 },
                    { operation: 'add', path: 'j/k/file', reason: 'new', position: 2 },
                ]);

                gTasks = [ ];
                syncer.sync(gTmpDir, collectTasks, 10, function (error) {
                    expect(error).to.not.be.ok();
                    expect(gTasks.length).to.be(0);

                    done();
                });
            });
        });
    });
});
