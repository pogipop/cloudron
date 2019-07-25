/* global it:false */
/* global describe:false */
/* global after:false */
/* global before:false */

'use strict';

var config = require('../config.js'),
    constants = require('../constants.js'),
    expect = require('expect.js'),
    fs = require('fs'),
    path = require('path');

describe('config', function () {
    before(function () {
        config._reset();
    });

    after(function () {
        config._reset();
    });

    it('baseDir() is set', function (done) {
        expect(config.baseDir()).to.be.ok();
        done();
    });

    it('can get version', function (done) {
        expect(constants.VERSION).to.be.ok(); // this gets a dummy text string
        expect(constants.VERSION.includes('\n')).to.not.be.ok();
        done();
    });

    it('did set default values', function () {
        expect(config.adminDomain()).to.equal('');
        expect(config.adminFqdn()).to.equal('');
    });

    it('set does not save custom values in file', function (done) {
        config.set('foobar', 'somevalue');
        expect(JSON.parse(fs.readFileSync(path.join(config.baseDir(), 'cloudron.conf'))).foobar).to.not.be.ok();
        done();
    });

    it('set - simple key value', function (done) {
        config.set('foobar', 'somevalue2');
        done();
    });

    it('set - object', function (done) {
        config.set( { adminDomain: 'something.com' } );
        expect(config.adminDomain()).to.eql('something.com');
        done();
    });

    it('uses dotted locations with custom domain', function () {
        config.setFqdn('example.com');
        config.setAdminFqdn('my.example.com');

        expect(config.adminDomain()).to.equal('example.com');
        expect(config.adminFqdn()).to.equal('my.example.com');
        expect(config.adminOrigin()).to.equal('https://my.example.com');
    });

    it('uses hyphen locations with non-custom domain', function () {
        config.setFqdn('test.example.com');
        config.setAdminFqdn('my-test.example.com');

        expect(config.adminDomain()).to.equal('test.example.com');
        expect(config.adminOrigin()).to.equal('https://my-test.example.com');
    });

    it('can set arbitrary values', function (done) {
        config.set('random', 'value');
        config.set('this.is.madness', 42);

        done();
    });
});
