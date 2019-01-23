'use strict';

var assert = require('assert'),
    async = require('async'),
    DataLayout = require('./datalayout.js'),
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

function readTree(dirPath) {
    assert.strictEqual(typeof dirPath, 'string');

    const names = safe.fs.readdirSync(dirPath).sort();
    if (!names) return [ ];

    return names.map((name) => {
        let absolutePath = path.join(dirPath, name);
        return {
            stat: safe.fs.lstatSync(absolutePath),
            absolutePath: absolutePath,
            name: name
        };
    });
}

function readDataLayoutTree(dataLayout) {
    assert.strictEqual(typeof dataLayout, 'object');

    let rootEntries = readTree(dataLayout.localRoot());

    for (let l of dataLayout.directoryMap()) {
        rootEntries.push({
            stat: safe.fs.lstatSync(l.localDir),
            absolutePath: l.localDir,
            name: l.remoteDir,
        });
    }

    return rootEntries.sort((e1, e2) => { return e1.name < e2.name ? -1 : (e1.name > e2.name ? +1 : 0); });
}

function ISDIR(x) {
    return (x & fs.constants.S_IFDIR) === fs.constants.S_IFDIR;
}

function ISFILE(x) {
    return (x & fs.constants.S_IFREG) === fs.constants.S_IFREG;
}

function sync(dataLayout, taskProcessor, concurrency, callback) {
    assert(dataLayout instanceof DataLayout, 'Expecting dataLayout to be a DataLayout');
    assert.strictEqual(typeof taskProcessor, 'function');
    assert.strictEqual(typeof concurrency, 'number');
    assert.strictEqual(typeof callback, 'function');

    var curCacheIndex = 0, addQueue = [ ], delQueue = [ ];

    var cacheFile = path.join(paths.BACKUP_INFO_DIR, dataLayout.getBasename() + '.sync.cache'),
        newCacheFile = path.join(paths.BACKUP_INFO_DIR, dataLayout.getBasename() + '.sync.cache.new');

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

    function traverse(entries, relpath) {
        for (const entry of entries) {
            let entryPath = path.join(relpath, entry.name);
            let entryStat = entry.stat;

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
                    traverse(readTree(entry.absolutePath), entryPath);
                } else {
                    addQueue.push({ operation: 'add', path: entryPath, reason: 'new', position: addQueue.length });
                }
            } else if (ISDIR(cacheStat.mode) && entryStat.isDirectory()) { // dir names match
                ++curCacheIndex;
                // if we just pass path, have to keep looking into data layout!!! so pass an object
                // the object needs to have the path where we are traversing...
                traverse(readTree(entry.absolutePath), entryPath);
            } else if (ISFILE(cacheStat.mode) && entryStat.isFile()) { // file names match
                if (entryStat.mtime.getTime() !== cacheStat.mtime || entryStat.size != cacheStat.size || entryStat.inode !== cacheStat.inode) { // file changed
                    addQueue.push({ operation: 'add', path: entryPath, reason: 'changed', position: addQueue.length });
                }
                ++curCacheIndex;
            } else if (entryStat.isDirectory()) { // was a file, now a directory
                delQueue.push({ operation: 'remove', path: cachePath, reason: 'wasfile' });
                ++curCacheIndex;
                traverse(readTree(entry.absolutePath), entryPath);
            } else { // was a dir, now a file
                delQueue.push({ operation: 'removedir', path: cachePath, reason: 'wasdir' });
                while (curCacheIndex !== cache.length && cache[curCacheIndex].path.startsWith(cachePath)) ++curCacheIndex;
                addQueue.push({ operation: 'add', path: entryPath, reason: 'wasdir', position: addQueue.length });
            }
        }
    }

    traverse(readDataLayoutTree(dataLayout), '');
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
