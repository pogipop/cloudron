/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    config = require('../config.js'),
    database = require('../database.js'),
    domains = require('../domains.js'),
    expect = require('expect.js'),
    _ = require('underscore');

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

    describe('validateHostname', function () {
        const domain = {
            domain: 'example.com',
            zoneName: 'example.com',
            config: {}
        };

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

        it('hyphenatedSubdomains', function () {
            let domainCopy = _.extend({}, domain);
            domainCopy.config.hyphenatedSubdomains = true;

            expect(domains.validateHostname('a',        domain)).to.be(null);
            expect(domains.validateHostname('a0-x',     domain)).to.be(null);
            expect(domains.validateHostname('a0.x',     domain)).to.be.an(Error);
        });
    });

    describe('getName', function () {
        it('works with zoneName==domain (not hyphenated)', function () {
            const domain = {
                domain: 'example.com',
                zoneName: 'example.com',
                config: {}
            };

            expect(domains._getName(domain, '', 'A')).to.be('');
            expect(domains._getName(domain, 'www', 'A')).to.be('www');
            expect(domains._getName(domain, 'www.dev', 'A')).to.be('www.dev');

            expect(domains._getName(domain, '', 'MX')).to.be('');

            expect(domains._getName(domain, '', 'TXT')).to.be('');
            expect(domains._getName(domain, 'www', 'TXT')).to.be('www');
            expect(domains._getName(domain, 'www.dev', 'TXT')).to.be('www.dev');
        });

        it('works when zoneName!=domain (not hyphenated)', function () {
            const domain = {
                domain: 'dev.example.com',
                zoneName: 'example.com',
                config: {}
            };

            expect(domains._getName(domain, '', 'A')).to.be('dev');
            expect(domains._getName(domain, 'www', 'A')).to.be('www.dev');
            expect(domains._getName(domain, 'www.dev', 'A')).to.be('www.dev.dev');

            expect(domains._getName(domain, '', 'MX')).to.be('dev');

            expect(domains._getName(domain, '', 'TXT')).to.be('dev');
            expect(domains._getName(domain, 'www', 'TXT')).to.be('www.dev');
            expect(domains._getName(domain, 'www.dev', 'TXT')).to.be('www.dev.dev');
        });

        it('works when hyphenated - level1', function () {
            const domain = {
                domain: 'customer.example.com',
                zoneName: 'example.com',
                config: {
                    hyphenatedSubdomains: true
                }
            };

            expect(domains._getName(domain, '', 'A')).to.be('customer');
            expect(domains._getName(domain, 'www', 'A')).to.be('www-customer');
            expect(domains._getName(domain, 'www.dev', 'A')).to.be('www.dev-customer');

            expect(domains._getName(domain, '', 'MX')).to.be('customer');

            expect(domains._getName(domain, '', 'TXT')).to.be('customer');
            expect(domains._getName(domain, '_dmarc', 'TXT')).to.be('_dmarc.customer');
            expect(domains._getName(domain, 'cloudron._domainkey', 'TXT')).to.be('cloudron._domainkey.customer');
            expect(domains._getName(domain, '_acme-challenge.my', 'TXT')).to.be('_acme-challenge.my-customer');
            expect(domains._getName(domain, '_acme-challenge', 'TXT')).to.be('_acme-challenge');
        });

        it('works when hyphenated - level2', function () {
            const domain = {
                domain: 'customer.dev.example.com',
                zoneName: 'example.com',
                config: {
                    hyphenatedSubdomains: true
                }
            };

            expect(domains._getName(domain, '', 'A')).to.be('customer.dev');
            expect(domains._getName(domain, 'www', 'A')).to.be('www-customer.dev');
            expect(domains._getName(domain, 'www.dev', 'A')).to.be('www.dev-customer.dev');

            expect(domains._getName(domain, '', 'MX')).to.be('customer.dev');

            expect(domains._getName(domain, '', 'TXT')).to.be('customer.dev');
            expect(domains._getName(domain, '_dmarc', 'TXT')).to.be('_dmarc.customer.dev');
            expect(domains._getName(domain, 'cloudron._domainkey', 'TXT')).to.be('cloudron._domainkey.customer.dev');
            expect(domains._getName(domain, '_acme-challenge.my', 'TXT')).to.be('_acme-challenge.my-customer.dev');
            expect(domains._getName(domain, '_acme-challenge', 'TXT')).to.be('_acme-challenge.dev');
        });

        it('works with caas', function () {
            const domain = {
                domain: 'customer.example.com',
                provider: 'caas',
                zoneName: 'example.com',
                config: {
                    hyphenatedSubdomains: true
                }
            };

            expect(domains._getName(domain, '', 'A')).to.be('');
            expect(domains._getName(domain, 'www', 'A')).to.be('www');
            expect(domains._getName(domain, 'www.dev', 'A')).to.be('www.dev');

            expect(domains._getName(domain, '', 'MX')).to.be('');

            expect(domains._getName(domain, '', 'TXT')).to.be('');
            expect(domains._getName(domain, '_dmarc', 'TXT')).to.be('_dmarc');
            expect(domains._getName(domain, 'cloudron._domainkey', 'TXT')).to.be('cloudron._domainkey');
            expect(domains._getName(domain, '_acme-challenge.my', 'TXT')).to.be('_acme-challenge.my');
            expect(domains._getName(domain, '_acme-challenge', 'TXT')).to.be('_acme-challenge');
        });
    });
});
