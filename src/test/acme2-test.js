/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../config.js'),
    database = require('../database.js'),
    acme2 = require('../cert/acme2.js'),
    expect = require('expect.js'),
    _ = require('underscore');

describe('Acme2', function () {
    before(function (done) {
        config._reset();

        async.series([
            database.initialize,
            database._clear
        ], done);
    });

    after(function (done) {
        async.series([
            database._clear,
            database.uninitialize
        ], done);
    });

    describe('getChallengeSubdomain', function () {
        it('non-wildcard', function () {
            expect(acme2._getChallengeSubdomain('example.com', 'example.com')).to.be('_acme-challenge');
            expect(acme2._getChallengeSubdomain('git.example.com', 'example.com')).to.be('_acme-challenge.git');
        });

        it('wildcard', function () {
            expect(acme2._getChallengeSubdomain('*.example.com', 'example.com')).to.be('_acme-challenge');
            expect(acme2._getChallengeSubdomain('*.git.example.com', 'example.com')).to.be('_acme-challenge.git');
            expect(acme2._getChallengeSubdomain('*.example.com', 'customer.example.com')).to.be('_acme-challenge'); // for hyphenatedSubdomains
        });
    });
});
