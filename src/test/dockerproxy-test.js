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
        exec(cmd, function (error, stdout, stderr) {
            expect(error).to.be(null);
            expect(stdout).to.contain('hello');
            expect(stderr).to.be.empty();
            done();
        });
    });

    it('proxy overwrites the container network option', function (done) {
        var cmd = `${DOCKER} run --network ifnotrewritethiswouldfail ubuntu "/bin/bash" "-c" "echo 'hello'"`;
        exec(cmd, function (error, stdout, stderr) {
            expect(error).to.be(null);
            expect(stdout).to.contain('hello');
            expect(stderr).to.be.empty();
            done();
        });
    });

    it('cannot see logs through docker logs, since syslog is configured', function (done) {
        exec(`${DOCKER} run -d ubuntu "bin/bash" "-c" "while true; do echo 'perpetual walrus'; sleep 1; done"`, function (error, stdout, stderr) {
            expect(error).to.be(null);
            expect(stderr).to.be.empty();

            var containerId = stdout.slice(0, -1); // removes the trailing \n

            exec(`${DOCKER} logs ${containerId}`, function (error, stdout, stderr) {
                expect(error.message).to.contain('configured logging driver does not support reading');
                expect(stderr).to.contain('configured logging driver does not support reading');
                expect(stdout).to.be.empty();

                exec(`${DOCKER} rm -f ${containerId}`, function (error, stdout, stderr) {
                    expect(error).to.be(null);
                    expect(stderr).to.be.empty();

                    done();
                });
            });
        });
    });
});
