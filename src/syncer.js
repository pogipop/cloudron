'use strict';

var assert = require('assert'),
    async = require('async'),
    debug = require('debug')('box:syncer'),
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

function sync(dir, taskProcessor, concurrency, callback) {
    assert.strictEqual(typeof dir, 'string');
    assert.strictEqual(typeof taskProcessor, 'function');
    assert.strictEqual(typeof concurrency, 'number');
    assert.strictEqual(typeof callback, 'function');

    var curCacheIndex = 0, addQueue = [ ], delQueue = [ ];

    var cacheFile = path.join(paths.SNAPSHOT_DIR, path.basename(dir) + '.cache'),
        newCacheFile = path.join(paths.SNAPSHOT_DIR, path.basename(dir) + '.cache.new');

    var cache = readCache(cacheFile);

    var newCacheFd = safe.fs.openSync(newCacheFile, 'w'); // truncates any existing file
    if (newCacheFd === -1) return callback(new Error('Error opening new cache file: ' + safe.error.message));

    function advanceCache(entryPath) {
        for (; curCacheIndex !== cache.length && (entryPath === '' || cache[curCacheIndex].path < entryPath); ++curCacheIndex) {
            delQueue.push({ operation: 'remove', path: cache[curCacheIndex].path });
        }
    }

    function traverse(relpath) {
        var entries = readTree(path.join(dir, relpath));

        for (var i = 0; i < entries.length; i++) {
            var entryPath = path.join(relpath, entries[i].name);
            var stat = entries[i].stat;

            if (!stat) continue; // some stat error
            if (!stat.isDirectory() && !stat.isFile()) continue;
            if (stat.isSymbolicLink()) continue;

            if (stat.isDirectory()) {
                traverse(entryPath);
                continue;
            }

            safe.fs.appendFileSync(newCacheFd, JSON.stringify({ path: entryPath, mtime: stat.mtime.getTime()  }) + '\n');

            advanceCache(entryPath);

            if (curCacheIndex !== cache.length && cache[curCacheIndex].path === entryPath) {
                if (stat.mtime.getTime() !== cache[curCacheIndex].mtime) {
                    addQueue.push({ operation: 'add', path: entryPath });
                }
                ++curCacheIndex;
            } else {
                addQueue.push({ operation: 'add', path: entryPath });
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