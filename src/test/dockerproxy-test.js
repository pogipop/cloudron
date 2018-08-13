/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var dockerProxy = require('../dockerproxy.js'),
    config = require('../config.js'),
    exec = require('child_process').exec,
    expect = require('expect.js');

const DOCKER = `docker -H tcp://localhost:${config.get('dockerProxyPort')} `;

describe('Cloudron', function () {
    this.timeout(1000000);

    before(dockerProxy.start);
    after(dockerProxy.stop);

    it('can get info', function (done) {
        exec(DOCKER + ' info', function (error, stdout, stderr) {
            expect(error).to.be(null);
            expect(stdout).to.contain('Containers:');
            expect(stderr).to.be.empty();
            done();
        });
    });

    it('can create container', function (done) {
        var cmd = DOCKER + ` run ubuntu "/bin/bash" "-c" "echo 'hello'"`;
        console.log(cmd)
        exec(cmd, function (error, stdout, stderr) {
            console.log(error, stdout, stderr)
            expect(error).to.be(null);
            expect(stdout).to.contain('hello');
            expect(stderr).to.be.empty();
            done();
        });
    });
});
