/* global it:false */
/* global describe:false */

'use strict';

var expect = require('expect.js'),
    sysinfo = require('../sysinfo.js');

describe('config', function () {
    it('test machine has IPv6 support', function () {
        expect(sysinfo.hasIPv6()).to.equal(true);
    });
});
