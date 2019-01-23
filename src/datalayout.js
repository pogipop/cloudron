'use strict';

let assert = require('assert'),
    path = require('path');

class DataLayout {
    constructor(localRoot, dirMap) {
        assert.strictEqual(typeof localRoot, 'string');
        assert(Array.isArray(dirMap), 'Expecting layout to be an array');

        this._localRoot = localRoot;
        this._dirMap = dirMap;
        this._remoteRegexps = dirMap.map((l) => new RegExp('^\\./' + l.remoteDir + '/?'));
        this._localRegexps = dirMap.map((l) => new RegExp('^' + l.localDir + '/?'));
    }
    toLocalPath(remoteName) {
        assert.strictEqual(typeof remoteName, 'string');

        for (let i = 0; i < this._remoteRegexps.length; i++) {
            if (!remoteName.match(this._remoteRegexps[i])) continue;
            return remoteName.replace(this._remoteRegexps[i], this._dirMap[i].localDir + '/'); // make paths absolute
        }
        return remoteName.replace(new RegExp('^\\.'), this._localRoot);
    }
    toRemotePath(localName) {
        assert.strictEqual(typeof localName, 'string');

        for (let i = 0; i < this._localRegexps.length; i++) {
            if (!localName.match(this._localRegexps[i])) continue;
            return localName.replace(this._localRegexps[i], './' + this._dirMap[i].remoteDir + '/'); // make paths relative
        }
        return localName.replace(new RegExp('^' + this._localRoot + '/?'), './');
    }
    localRoot() {
        return this._localRoot;
    }
    getBasename() { // used to generate cache file names
        return path.basename(this._localRoot);
    }
    toString() {
        return JSON.stringify({ localRoot: this._localRoot, layout: this._dirMap });
    }
    localPaths() {
        return [ this._localRoot ].concat(this._dirMap.map((l) => l.localDir));
    }
    directoryMap() {
        return this._dirMap;
    }
    static fromString(str) {
        const obj = JSON.parse(str);
        return new DataLayout(obj.localRoot, obj.layout);
    }
}

exports = module.exports = DataLayout;
