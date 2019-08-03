'use strict';

let assert = require('assert'),
    fs = require('fs'),
    path = require('path');

exports = module.exports = {
    getChanges: getChanges
};

function getChanges(version) {
    assert.strictEqual(typeof version, 'string');

    let changelog = [ ];
    const lines = fs.readFileSync(path.join(__dirname, '../CHANGES'), 'utf8').split('\n');

    version = version.replace(/[+-].*/, ''); // strip prerelease

    let i;
    for (i = 0; i < lines.length; i++) {
        if (lines[i] === '[' + version + ']') break;
    }

    for (i = i + 1; i < lines.length; i++) {
        if (lines[i] === '') continue;
        if (lines[i][0] === '[') break;

        lines[i] = lines[i].trim();

        // detect and remove list style - and * in changelog lines
        if (lines[i].indexOf('-') === 0) lines[i] = lines[i].slice(1).trim();
        if (lines[i].indexOf('*') === 0) lines[i] = lines[i].slice(1).trim();

        changelog.push(lines[i]);
    }

    return changelog;
}
