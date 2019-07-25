/* global it:false */
/* global describe:false */
/* global after:false */
/* global before:false */

'use strict';

var config = require('../config.js'),
    expect = require('expect.js'),
    sysinfo = require('../sysinfo.js');

describe('config', function () {
    before(function () {
        config._reset();
    });

    after(function () {
        config._reset();
    });

    it('test machine has IPv6 support', function () {
        expect(sysinfo.hasIPv6()).to.equal(true);
    });
});
