'use strict';

// -------------------------------------------
//  This file just describes the interface
//
//  New backends can start from here
// -------------------------------------------

exports = module.exports = {
    getPublicIp: getPublicIp
};

var assert = require('assert');

function getPublicIp(callback) {
    assert.strictEqual(typeof callback, 'function');

    callback(new Error('not implemented'));
}

