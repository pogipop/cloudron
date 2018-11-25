/* jslint node:true */
/* global it:false */
/* global describe:false */

'use strict';

var expect = require('expect.js'),
    path = require('path'),
    shell = require('../shell.js');

describe('shell', function () {
    it('can run valid program', function (done) {
        var cp = shell.spawn('test', 'ls', [ '-l' ], { }, function (error) {
            expect(cp).to.be.ok();
            expect(error).to.be(null);
            done();
        });
    });

    it('fails on invalid program', function (done) {
        shell.spawn('test', 'randomprogram', [ ], { }, function (error) {
            expect(error).to.be.ok();
            done();
        });
    });

    it('fails on failing program', function (done) {
        shell.spawn('test', '/usr/bin/false', [ ], { }, function (error) {
            expect(error).to.be.ok();
            done();
        });
    });

    it('cannot sudo invalid program', function (done) {
        shell.sudo('test', [ 'randomprogram' ], {}, function (error) {
            expect(error).to.be.ok();
            done();
        });
    });

    it('can sudo valid program', function (done) {
        var RELOAD_NGINX_CMD = path.join(__dirname, '../src/scripts/reloadnginx.sh');
        shell.sudo('test', [ RELOAD_NGINX_CMD ], {}, function (error) {
            expect(error).to.be.ok();
            done();
        });
    });

    it('execSync a valid shell program', function (done) {
        shell.exec('test', 'ls -l | wc -c', function (error) {
            console.log(error);
            done(error);
        });
    });

    it('execSync throws for invalid program', function (done) {
        shell.exec('test', 'cannotexist', function (error) {
            expect(error).to.be.ok();
            done();
        });
    });

    it('execSync throws for failed program', function (done) {
        shell.exec('test', 'false', function (error) {
            expect(error).to.be.ok();
            done();
        });
    });
});
