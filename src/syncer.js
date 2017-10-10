'use strict';

var assert = require('assert'),
    async = require('async'),
    debug = require('debug')('box:syncer'),
    fs = require('fs'),
    path = require('path'),
    paths = require('./paths.js'),
    safe = require('safetydance');

exports = module.exports = {
    sync: sync
};

function readCache(cacheFile) {
    assert.strictEqual(typeof cacheFile, 'string');

    var cache = safe.fs.readFileSync(cacheFile, 'utf8');
    if (!cache) return [ ];
    var result = cache.trim().split('\n').map(JSON.parse);
    return result;
}

function readTree(dir) {
    assert.strictEqual(typeof dir, 'string');

    var list = safe.fs.readdirSync(dir).sort();
    if (!list) return [ ];

    return list.map(function (e) { return { stat: safe.fs.lstatSync(path.join(dir, e)), name: e }; });
}

function ISDIR(x) {
    return (x & fs.constants.S_IFDIR) === fs.constants.S_IFDIR;
}

function ISFILE(x) {
    return (x & fs.constants.S_IFREG) === fs.constants.S_IFREG;
}

function sync(dir, taskProcessor, concurrency, callback) {
    assert.strictEqual(typeof dir, 'string');
    assert.strictEqual(typeof taskProcessor, 'function');
    assert.strictEqual(typeof concurrency, 'number');
    assert.strictEqual(typeof callback, 'function');

    var curCacheIndex = 0, addQueue = [ ], delQueue = [ ];

    var cacheFile = path.join(paths.BACKUP_INFO_DIR, path.basename(dir) + '.sync.cache'),
        newCacheFile = path.join(paths.BACKUP_INFO_DIR, path.basename(dir) + '.sync.cache.new');

    var cache = [ ];

    // if cache is missing or if we crashed/errored in previous run, start out empty. TODO: do a remote listDir and rebuild
    if (!safe.fs.existsSync(cacheFile)) {
        delQueue.push({ operation: 'removedir', path: '', reason: 'nocache' });
    } else if (safe.fs.existsSync(newCacheFile)) {
        delQueue.push({ operation: 'removedir', path: '', reason: 'crash' });
    } else {
        cache = readCache(cacheFile);
    }

    var newCacheFd = safe.fs.openSync(newCacheFile, 'w'); // truncates any existing file
    if (newCacheFd === -1) return callback(new Error('Error opening new cache file: ' + safe.error.message));

    function advanceCache(entryPath) {
        var lastRemovedDir = null;

        for (; curCacheIndex !== cache.length && (entryPath === '' || cache[curCacheIndex].path < entryPath); ++curCacheIndex) {
            // ignore subdirs of lastRemovedDir since it was removed already
            if (lastRemovedDir && cache[curCacheIndex].path.startsWith(lastRemovedDir)) continue;

            if (ISDIR(cache[curCacheIndex].stat.mode)) {
                delQueue.push({ operation: 'removedir', path: cache[curCacheIndex].path, reason: 'missing' });
                lastRemovedDir = cache[curCacheIndex].path;
            } else {
                delQueue.push({ operation: 'remove', path: cache[curCacheIndex].path, reason: 'missing' });
                lastRemovedDir = null;
            }
        }
    }

    function traverse(relpath) {
        var entries = readTree(path.join(dir, relpath));

        for (var i = 0; i < entries.length; i++) {
            var entryPath = path.join(relpath, entries[i].name);
            var entryStat = entries[i].stat;

            if (!entryStat) continue; // some stat error. prented it doesn't exist
            if (!entryStat.isDirectory() && !entryStat.isFile()) continue; // ignore non-files and dirs
            if (entryStat.isSymbolicLink()) continue;

            safe.fs.appendFileSync(newCacheFd, JSON.stringify({ path: entryPath, stat: { mtime: entryStat.mtime.getTime(), size: entryStat.size, inode: entryStat.inode, mode: entryStat.mode } }) + '\n');

            if (curCacheIndex !== cache.length && cache[curCacheIndex].path < entryPath) { // files disappeared. first advance cache as needed
                advanceCache(entryPath);
            }

            const cachePath = curCacheIndex === cache.length ? null : cache[curCacheIndex].path;
            const cacheStat = curCacheIndex === cache.length ? null : cache[curCacheIndex].stat;

            if (cachePath === null || cachePath > entryPath) { // new files appeared
                if (entryStat.isDirectory()) {
                    traverse(entryPath);
                } else {
                    addQueue.push({ operation: 'add', path: entryPath, reason: 'new' });
                }
            } else if (ISDIR(cacheStat.mode) && entryStat.isDirectory()) { // dir names match
                ++curCacheIndex;
                traverse(entryPath);
            } else if (ISFILE(cacheStat.mode) && entryStat.isFile()) { // file names match
                if (entryStat.mtime.getTime() !== cacheStat.mtime || entryStat.size != cacheStat.size || entryStat.inode !== cacheStat.inode) { // file changed
                    addQueue.push({ operation: 'add', path: entryPath, reason: 'changed' });
                }
                ++curCacheIndex;
            } else if (entryStat.isDirectory()) { // was a file, now a directory
                delQueue.push({ operation: 'remove', path: cachePath, reason: 'wasfile' });
                ++curCacheIndex;
                traverse(entryPath);
            } else { // was a dir, now a file
                delQueue.push({ operation: 'removedir', path: cachePath, reason: 'wasdir' });
                while (curCacheIndex !== cache.length && cache[curCacheIndex].path.startsWith(cachePath)) ++curCacheIndex;
                addQueue.push({ operation: 'add', path: entryPath, reason: 'wasdir' });
            }
        }
    }

    traverse('');
    advanceCache(''); // remove rest of the cache entries

    safe.fs.closeSync(newCacheFd);

    debug('Processing %s deletes and %s additions', delQueue.length, addQueue.length);

    async.eachLimit(delQueue, concurrency, taskProcessor, function (error) {
        debug('Done processing deletes', error);

        async.eachLimit(addQueue, concurrency, taskProcessor, function (error) {
            debug('Done processing adds', error);

            if (error) return callback(error);

            safe.fs.unlinkSync(cacheFile);

            if (!safe.fs.renameSync(newCacheFile, cacheFile)) debug('Unable to save new cache file');

            callback();
        });
    });
}
