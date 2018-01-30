'use strict';

exports = module.exports = {
    getCertificate: getCertificate,

    // testing
    _name: 'fallback'
};

var assert = require('assert'),
    debug = require('debug')('box:cert/fallback.js');

function getCertificate(vhost, options, callback) {
    assert.strictEqual(typeof vhost, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('getCertificate: using fallback certificate', vhost);

    return callback(null, '', '');
}
