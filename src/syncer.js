'use strict';

var assert = require('assert'),
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
    var result = cache.split('\n').map(JSON.parse);
    return result;
}

function readTree(dir) {
    assert.strictEqual(typeof dir, 'string');

    var list = safe.fs.readdirSync(dir).sort();
    if (!list) return [ ];

    // TODO: handle lstat errors
    return list.map(function (e) { return { stat: fs.lstatSync(path.join(dir, e)), name: e }; });
}

// TODO: concurrency
// TODO: if dir became a file, remove the dir first
// TODO: write to index can simply append to a new cache file
function sync(dir, taskProcessor, callback) {
    assert.strictEqual(typeof dir, 'string');
    assert.strictEqual(typeof taskProcessor, 'function');
    assert.strictEqual(typeof callback, 'function');

    var curCacheIndex = 0, newCache = [ ];
    var cache = readCache(path.join(paths.SNAPSHOT_DIR, path.basename(dir) + '.cache'));

    var dummyCallback = function() { };

    function advanceCache(entryPath) {
        for (; curCacheIndex !== cache.length && (entryPath === '' || cache[curCacheIndex].path < entryPath); ++curCacheIndex) {
            taskProcessor({ operation: 'remove', path: cache[curCacheIndex].path }, dummyCallback);
        }
    }

    function traverse(relpath) {
        var entries = readTree(path.join(dir, relpath));

        for (var i = 0; i < entries.length; i++) {
            var entryPath = path.join(relpath, entries[i].name);

            if (entries[i].stat.isSymbolicLink()) continue;

            if (entries[i].stat.isDirectory()) {
                traverse(entryPath);
                continue;
            }

            newCache.push({ stat: entries[i].stat, path: entryPath });

            advanceCache(entryPath);

            if (curCacheIndex !== cache.length && cache[curCacheIndex].path === entryPath) {
                if (entries[i].stat.mtime.getTime() !== cache[curCacheIndex].mtime) {
                    taskProcessor({ operation: 'add', path: entryPath }, dummyCallback);
                }
                ++curCacheIndex;
            } else {
                taskProcessor({ operation: 'add', path: entryPath }, dummyCallback);
            }
        }
    }

    traverse('');
    advanceCache('');               // remove rest of the cache entries

    var newCacheContents = newCache.map(function (ce) { return JSON.stringify({ path: ce.path, mtime: ce.stat.mtime.getTime() }); }).join('\n');
    fs.writeFileSync(path.join(paths.SNAPSHOT_DIR, path.basename(dir) + '.cache'), newCacheContents, 'utf8');

    callback();
}