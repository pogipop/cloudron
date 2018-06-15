/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var accesscontrol = require('../accesscontrol.js'),
    expect = require('expect.js');

describe('access control', function () {
    describe('canonicalScope', function () {
        it('only * scope', function () {
            expect(accesscontrol.canonicalScope('*')).to.be('apps,clients,cloudron,domains,mail,profile,settings,users');
        });

        it('* in the middle', function () {
            expect(accesscontrol.canonicalScope('foo,bar,*')).to.be('foo,bar,apps,clients,cloudron,domains,mail,profile,settings,users');
        });
    });
});
