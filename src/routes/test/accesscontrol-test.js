/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var accesscontrol = require('../accesscontrol.js'),
    expect = require('expect.js'),
    HttpError = require('connect-lastmile').HttpError,
    passport = require('passport');

describe('scopes middleware', function () {
    var passportAuthenticateSave = null;

    before(function () {
        passportAuthenticateSave = passport.authenticate;
        passport.authenticate = function () {
            return function (req, res, next) { next(); };
        };
    });

    after(function () {
        passport.authenticate = passportAuthenticateSave;
    });

    it('fails due to empty scope in request', function (done) {
        var mw = accesscontrol.scope('admin')[1];
        var req = { authInfo: { authorizedScopes: [ ] } };

        mw(req, null, function (error) {
            expect(error).to.be.a(HttpError);
            done();
        });
    });

    it('fails due to wrong scope in request', function (done) {
        var mw = accesscontrol.scope('admin')[1];
        var req = { authInfo: { authorizedScopes: [ 'foobar', 'something' ] } };

        mw(req, null, function (error) {
            expect(error).to.be.a(HttpError);
            done();
        });
    });

    it('fails due to wrong scope in request', function (done) {
        var mw = accesscontrol.scope('admin,users')[1];
        var req = { authInfo: { authorizedScopes: [ 'foobar', 'admin' ] } };

        mw(req, null, function (error) {
            expect(error).to.be.a(HttpError);
            done();
        });
    });

    it('succeeds with one requested scope and one provided scope', function (done) {
        var mw = accesscontrol.scope('admin')[1];
        var req = { authInfo: { authorizedScopes: [ 'admin' ] } };

        mw(req, null, function (error) {
            expect(error).to.not.be.ok();
            done();
        });
    });

    it('succeeds with one requested scope and two provided scopes', function (done) {
        var mw = accesscontrol.scope('admin')[1];
        var req = { authInfo: { authorizedScopes: [ 'foobar', 'admin' ] } };

        mw(req, null, function (error) {
            expect(error).to.not.be.ok();
            done();
        });
    });

    it('succeeds with two requested scope and two provided scopes', function (done) {
        var mw = accesscontrol.scope('admin,foobar')[1];
        var req = { authInfo: { authorizedScopes: [ 'foobar', 'admin' ] } };

        mw(req, null, function (error) {
            expect(error).to.not.be.ok();
            done();
        });
    });

    it('succeeds with two requested scope and provided wildcard scope', function (done) {
        var mw = accesscontrol.scope('admin,foobar')[1];
        var req = { authInfo: { authorizedScopes: [ '*' ] } };

        mw(req, null, function (error) {
            expect(error).to.not.be.ok();
            done();
        });
    });
});
