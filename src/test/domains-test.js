/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../config.js'),
    database = require('../database.js'),
    domains = require('../domains.js'),
    expect = require('expect.js');

describe('Domains', function () {
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

    let domain = {
        domain: 'example.com',
        zoneName: 'example.com',
        config: {}
    };

    describe('validateHostname', function () {
        it('does not allow admin subdomain', function () {
            config.setFqdn('example.com');
            config.setAdminFqdn('my.example.com');

            expect(domains.validateHostname('my', domain)).to.be.an(Error);
        });

        it('cannot have >63 length subdomains', function () {
            var s = Array(64).fill('s').join('');
            expect(domains.validateHostname(s, domain)).to.be.an(Error);
            domain.zoneName = `dev.${s}.example.com`;
            expect(domains.validateHostname(`dev.${s}`, domain)).to.be.an(Error);
        });

        it('allows only alphanumerics and hypen', function () {
            expect(domains.validateHostname('#2r',   domain)).to.be.an(Error);
            expect(domains.validateHostname('a%b',   domain)).to.be.an(Error);
            expect(domains.validateHostname('ab_',   domain)).to.be.an(Error);
            expect(domains.validateHostname('ab.',   domain)).to.be.an(Error);
            expect(domains.validateHostname('ab..c', domain)).to.be.an(Error);
            expect(domains.validateHostname('.ab',   domain)).to.be.an(Error);
            expect(domains.validateHostname('-ab',   domain)).to.be.an(Error);
            expect(domains.validateHostname('ab-',   domain)).to.be.an(Error);
        });

        it('total length cannot exceed 255', function () {
            var s = '';
            for (var i = 0; i < (255 - 'example.com'.length); i++) s += 's';

            expect(domains.validateHostname(s, domain)).to.be.an(Error);
        });

        it('allow valid domains', function () {
            expect(domains.validateHostname('a',        domain)).to.be(null);
            expect(domains.validateHostname('a0-x',     domain)).to.be(null);
            expect(domains.validateHostname('a0.x',     domain)).to.be(null);
            expect(domains.validateHostname('a0.x.y',   domain)).to.be(null);
            expect(domains.validateHostname('01',       domain)).to.be(null);
        });
    });
});
