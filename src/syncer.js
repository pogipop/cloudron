'use strict';

var assert = require('assert'),
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

// TODO: concurrency
// TODO: if dir became a file, remove the dir first
function sync(dir, taskProcessor, callback) {
    assert.strictEqual(typeof dir, 'string');
    assert.strictEqual(typeof taskProcessor, 'function');
    assert.strictEqual(typeof callback, 'function');

    var curCacheIndex = 0;
    var cacheFile = path.join(paths.SNAPSHOT_DIR, path.basename(dir) + '.cache'),
        newCacheFile = path.join(paths.SNAPSHOT_DIR, path.basename(dir) + '.cache.new');

    var cache = readCache(cacheFile);

    var newCacheFd = safe.fs.openSync(newCacheFile, 'w'); // truncates any existing file
    if (newCacheFd === -1) return callback(new Error('Error opening new cache file: ' + safe.error.message));

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
                    taskProcessor({ operation: 'add', path: entryPath }, dummyCallback);
                }
                ++curCacheIndex;
            } else {
                taskProcessor({ operation: 'add', path: entryPath }, dummyCallback);
            }
        }
    }

    traverse('');
    advanceCache(''); // remove rest of the cache entries

    // move the new cache file
    safe.fs.closeSync(newCacheFd);
    safe.fs.unlinkSync(cacheFile);

    if (!safe.fs.renameSync(newCacheFile, cacheFile)) debug('Unable to save new cache file');

    callback();
}