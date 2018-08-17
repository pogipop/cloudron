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

describe('Dockerproxy', function () {
    var containerId;

    // create a container to test against
    before(function (done) {
        dockerProxy.start(function (error) {
            expect(error).to.not.be.ok();

            exec(`${DOCKER} run -d ubuntu "bin/bash" "-c" "while true; do echo 'perpetual walrus'; sleep 1; done"`, function (error, stdout, stderr) {
                expect(error).to.be(null);
                expect(stderr).to.be.empty();

                containerId = stdout.slice(0, -1); // removes the trailing \n

                done();
            });
        });
    });

    after(function (done) {
        exec(`${DOCKER} rm -f ${containerId}`, function (error, stdout, stderr) {
            expect(error).to.be(null);
            expect(stderr).to.be.empty();

            dockerProxy.stop(done);
        });
    });

    // uncomment this to run the proxy for manual testing
    // this.timeout(1000000);
    // it('wait', function (done) {} );

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
        exec(`${DOCKER} logs ${containerId}`, function (error, stdout, stderr) {
            expect(error.message).to.contain('configured logging driver does not support reading');
            expect(stderr).to.contain('configured logging driver does not support reading');
            expect(stdout).to.be.empty();

            done();
        });
    });

    it('can use PUT to upload archive into a container', function (done) {
        exec(`${DOCKER} cp -a ${__dirname}/proxytestarchive.tar ${containerId}:/tmp/`, function (error, stdout, stderr) {
            expect(error).to.be(null);
            expect(stderr).to.be.empty();
            expect(stdout).to.be.empty();

            done();
        });
    });

    it('can exec into a container', function (done) {
        exec(`${DOCKER} exec ${containerId} ls`, function (error, stdout, stderr) {
            expect(error).to.be(null);
            expect(stderr).to.be.empty();
            expect(stdout).to.equal('bin\nboot\ndev\netc\nhome\nlib\nlib64\nmedia\nmnt\nopt\nproc\nroot\nrun\nsbin\nsrv\nsys\ntmp\nusr\nvar\n');

            done();
        });
    });
});
