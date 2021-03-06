/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var accesscontrol = require('../accesscontrol.js'),
    expect = require('expect.js');

describe('access control', function () {
    describe('canonicalScopeString', function () {
        it('only * scope', function () {
            expect(accesscontrol.canonicalScopeString('*')).to.be(accesscontrol.VALID_SCOPES.join(','));
        });

        it('identity for non-*', function () {
            expect(accesscontrol.canonicalScopeString('foo,bar')).to.be('bar,foo'); // becomes sorted
        });
    });

    describe('intersectScopes', function () { // args: allowed, wanted
        it('both are same', function () {
            expect(accesscontrol.intersectScopes([ 'apps', 'clients' ], [ 'apps', 'clients' ])).to.eql([ 'apps', 'clients' ]);
        });

        it('some are different', function () {
            expect(accesscontrol.intersectScopes([ 'apps' ], [ 'apps', 'clients' ])).to.eql(['apps']);
            expect(accesscontrol.intersectScopes([ 'clients', 'domains', 'mail' ], [ 'mail' ])).to.eql(['mail']);
        });

        it('everything is different', function () {
            expect(accesscontrol.intersectScopes(['cloudron', 'domains' ], ['apps','clients'])).to.eql([]);
        });

        it('subscopes', function () {
            expect(accesscontrol.intersectScopes(['apps:read' ], ['apps'])).to.eql(['apps:read']);
            expect(accesscontrol.intersectScopes(['apps:read','domains','profile'], ['apps','domains:manage','profile'])).to.eql(['apps:read','domains:manage','profile']);
            expect(accesscontrol.intersectScopes(['apps:read','domains','profile'], ['apps','apps:read'])).to.eql(['apps:read']);
        });
    });

    describe('validateScopeString', function () {
        it('allows valid scopes', function () {
            expect(accesscontrol.validateScopeString('apps')).to.be(null);
            expect(accesscontrol.validateScopeString('apps,mail')).to.be(null);
            expect(accesscontrol.validateScopeString('apps:read,mail')).to.be(null);
            expect(accesscontrol.validateScopeString('apps,mail:write')).to.be(null);
        });

        it('disallows invalid scopes', function () {
            expect(accesscontrol.validateScopeString('apps, mail')).to.be.an(Error);
            expect(accesscontrol.validateScopeString('random')).to.be.an(Error);
            expect(accesscontrol.validateScopeString('')).to.be.an(Error);
        });
    });

    describe('hasScopes', function () {
        it('succeeds if it contains the scope', function () {
            expect(accesscontrol.hasScopes([ 'apps' ], [ 'apps' ])).to.be(null);
            expect(accesscontrol.hasScopes([ 'apps', 'mail' ], [ 'mail' ])).to.be(null);
            expect(accesscontrol.hasScopes([ 'clients', '*', 'apps', 'mail' ], [ 'mail' ])).to.be(null);

            // subscope
            expect(accesscontrol.hasScopes([ 'apps' ], [ 'apps:read' ])).to.be(null);
            expect(accesscontrol.hasScopes([ 'apps:read' ], [ 'apps:read' ])).to.be(null);
            expect(accesscontrol.hasScopes([ 'apps' , 'mail' ], [ 'apps:*' ])).to.be(null);
            expect(accesscontrol.hasScopes([ '*' ], [ 'apps:read' ])).to.be(null);
        });

        it('fails if it does not contain the scope', function () {
            expect(accesscontrol.hasScopes([ 'apps' ], [ 'mail' ])).to.be.an(Error);
            expect(accesscontrol.hasScopes([ 'apps', 'mail' ], [ 'clients' ])).to.be.an(Error);

            // subscope
            expect(accesscontrol.hasScopes([ 'apps:write' ], [ 'apps:read' ])).to.be.an(Error);
        });
    });
});
