'use strict';

exports = module.exports = asyncIf;

let assert = require('assert');

function asyncIf(condition, func, callback) {
    assert.strictEqual(typeof condition, 'boolean');
    assert.strictEqual(typeof func, 'function');
    assert.strictEqual(typeof callback, 'function');

    if (!condition) return callback();

    func(callback);
}

