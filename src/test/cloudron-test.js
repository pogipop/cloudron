/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    cloudron = require('../cloudron.js'),
    database = require('../database.js'),
    expect = require('expect.js');

function setup(done) {
    async.series([
        database.initialize,
        database._clear
    ], done);
}

function cleanup(done) {
    async.series([
        database._clear,
        database.uninitialize
    ], done);
}

describe('Cloudron', function () {
    before(setup);
    after(cleanup);

    it('can check for disk space', function (done) {
        cloudron._checkDiskSpace(function (error) {
            expect(!error).to.be.ok();
            done();
        });
    });
});

