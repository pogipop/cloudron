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

    describe('validateScope', function () {
        it('allows valid scopes', function () {
            expect(accesscontrol.validateScope('apps')).to.be(null);
            expect(accesscontrol.validateScope('apps,mail')).to.be(null);
            expect(accesscontrol.validateScope('apps:read,mail')).to.be(null);
            expect(accesscontrol.validateScope('apps,mail:write')).to.be(null);
        });

        it('disallows invalid scopes', function () {
            expect(accesscontrol.validateScope('apps, mail')).to.be.an(Error);
            expect(accesscontrol.validateScope('random')).to.be.an(Error);
            expect(accesscontrol.validateScope('')).to.be.an(Error);
        });
    });

    describe('hasScopes', function () {
        it('succeeds if it contains the scope', function () {
            expect(accesscontrol.hasScopes({ scope: 'apps' }, [ 'apps' ])).to.be(null);
            expect(accesscontrol.hasScopes({ scope: 'apps,mail' }, [ 'mail' ])).to.be(null);
            expect(accesscontrol.hasScopes({ scope: 'clients,*,apps,mail' }, [ 'mail' ])).to.be(null);

            // subscope
            expect(accesscontrol.hasScopes({ scope: 'apps' }, [ 'apps:read' ])).to.be(null);
            expect(accesscontrol.hasScopes({ scope: 'apps:read' }, [ 'apps:read' ])).to.be(null);
            expect(accesscontrol.hasScopes({ scope: 'apps,mail' }, [ 'apps:*' ])).to.be(null);
            expect(accesscontrol.hasScopes({ scope: '*' }, [ 'apps:read' ])).to.be(null);
        });

        it('fails if it does not contain the scope', function () {
            expect(accesscontrol.hasScopes({ scope: 'apps' }, [ 'mail' ])).to.be.an(Error);
            expect(accesscontrol.hasScopes({ scope: 'apps,mail' }, [ 'clients' ])).to.be.an(Error);

            // subscope
            expect(accesscontrol.hasScopes({ scope: 'apps:write' }, [ 'apps:read' ])).to.be.an(Error);
        });
    });

    describe('validateRoles', function () {
        it('succeeds for valid roles', function () {
            expect(accesscontrol.validateRoles([ accesscontrol.ROLE_OWNER ])).to.be(null);
        });

        it('fails for invalid roles', function () {
            expect(accesscontrol.validateRoles([ 'janitor' ])).to.be.an(Error);
        });
    });
});
