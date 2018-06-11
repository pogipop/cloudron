'use strict';

exports = module.exports = hat;

var crypto = require('crypto');

function hat (bits) {
    return crypto.randomBytes(bits / 8).toString('hex');
}
