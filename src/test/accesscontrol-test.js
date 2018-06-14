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

    describe('intersectScope', function () { // args: allowed, wanted
        it('both are same', function () {
            expect(accesscontrol.intersectScope('apps,clients', 'clients,apps')).to.be('apps,clients');
        });

        it('some are different', function () {
            expect(accesscontrol.intersectScope('apps', 'clients,apps')).to.be('apps');
            expect(accesscontrol.intersectScope('clients,domains,mail', 'mail')).to.be('mail');
        });

        it('* in allowed', function () {
            expect(accesscontrol.intersectScope('*', 'clients,apps')).to.be('clients,apps');
            expect(accesscontrol.intersectScope('foo,*,bar', 'mail')).to.be('mail');
        });

        it('* in wanted', function () {
            expect(accesscontrol.intersectScope('clients,apps', '*')).to.be('clients,apps');
            expect(accesscontrol.intersectScope('mail', 'bar,*,foo')).to.be('mail');
            expect(accesscontrol.intersectScope('*', '*')).to.be('apps,clients,cloudron,domains,mail,profile,settings,users');
        });

        it('everything is different', function () {
            expect(accesscontrol.intersectScope('cloudron,domains', 'clients,apps')).to.be('');
        });

    });
});
