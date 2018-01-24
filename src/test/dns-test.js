/* jslint node:true */
/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    AWS = require('aws-sdk'),
    GCDNS = require('@google-cloud/dns'),
    config = require('../config.js'),
    database = require('../database.js'),
    domains = require('../domains.js'),
    expect = require('expect.js'),
    nock = require('nock'),
    settings = require('../settings.js'),
    util = require('util');

var DOMAIN_0 = {
    domain: 'example-dns-test.com',
    zoneName: 'example-dns-test.com',
    provider: 'manual',
    config: {}
};

describe('dns provider', function () {
    before(function (done) {
        config._reset();
        config.setFqdn(DOMAIN_0.domain);

        async.series([
            database.initialize,
            settings.initialize,
            database._clear
        ], done);
    });

    after(function (done) {
        async.series([
            database._clear,
            database.uninitialize
        ], done);
    });

    describe('noop', function () {
        before(function (done) {
            DOMAIN_0.provider = 'noop'
            DOMAIN_0.config = {
            };

            domains.update(DOMAIN_0.domain, DOMAIN_0.provider, DOMAIN_0.config, null, done);
        });

        it('upsert succeeds', function (done) {
            domains.upsertDNSRecords('test', DOMAIN_0.domain, 'A', [ '1.2.3.4' ], function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.eql('noop-record-id');

                done();
            });
        });

        it('get succeeds', function (done) {
            domains.getDNSRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.eql(0);

                done();
            });
        });

        it('del succeeds', function (done) {
            domains.removeDNSRecords('test', DOMAIN_0.domain, 'A', [ '1.2.3.4' ], function (error) {
                expect(error).to.eql(null);

                done();
            });
        });
    });

    describe('digitalocean', function () {
        var TOKEN = 'sometoken';
        var DIGITALOCEAN_ENDPOINT = 'https://api.digitalocean.com';

        before(function (done) {
            DOMAIN_0.provider = 'digitalocean';
            DOMAIN_0.config = {
                token: TOKEN
            };

            domains.update(DOMAIN_0.domain, DOMAIN_0.provider, DOMAIN_0.config, null, done);
        });

        it('upsert non-existing record succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = {
                id: 3352892,
                type: 'A',
                name: '@',
                data: '1.2.3.4',
                priority: null,
                port: null,
                weight: null
            };

            var req1 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .get('/v2/domains/' + config.zoneName() + '/records')
                .reply(200, { domain_records: [] });
            var req2 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .post('/v2/domains/' + config.zoneName() + '/records')
                .reply(201, { domain_record: DOMAIN_RECORD_0 });

            domains.upsertDNSRecords('test', DOMAIN_0.domain, 'A', [ '1.2.3.4' ], function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.eql('3352892');
                expect(req1.isDone()).to.be.ok();
                expect(req2.isDone()).to.be.ok();

                done();
            });
        });

        it('upsert existing record succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = {
                id: 3352892,
                type: 'A',
                name: '@',
                data: '1.2.3.4',
                priority: null,
                port: null,
                weight: null
            };

            var DOMAIN_RECORD_1 = {
                id: 3352893,
                type: 'A',
                name: 'test',
                data: '1.2.3.4',
                priority: null,
                port: null,
                weight: null
            };

            var DOMAIN_RECORD_1_NEW = {
                id: 3352893,
                type: 'A',
                name: 'test',
                data: '1.2.3.5',
                priority: null,
                port: null,
                weight: null
            };

            var req1 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .get('/v2/domains/' + config.zoneName() + '/records')
                .reply(200, { domain_records: [ DOMAIN_RECORD_0, DOMAIN_RECORD_1 ] });
            var req2 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .put('/v2/domains/' + config.zoneName() + '/records/' + DOMAIN_RECORD_1.id)
                .reply(200, { domain_record: DOMAIN_RECORD_1_NEW });

            domains.upsertDNSRecords('test', DOMAIN_0.domain, 'A', [ DOMAIN_RECORD_1_NEW.data ], function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.eql('3352893');
                expect(req1.isDone()).to.be.ok();
                expect(req2.isDone()).to.be.ok();

                done();
            });
        });

        it('upsert multiple record succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = {
                id: 3352892,
                type: 'A',
                name: '@',
                data: '1.2.3.4',
                priority: null,
                port: null,
                weight: null
            };

            var DOMAIN_RECORD_1 = {
                id: 3352893,
                type: 'TXT',
                name: '@',
                data: '1.2.3.4',
                priority: null,
                port: null,
                weight: null
            };

            var DOMAIN_RECORD_1_NEW = {
                id: 3352893,
                type: 'TXT',
                name: '@',
                data: 'somethingnew',
                priority: null,
                port: null,
                weight: null
            };

            var DOMAIN_RECORD_2 = {
                id: 3352894,
                type: 'TXT',
                name: '@',
                data: 'something',
                priority: null,
                port: null,
                weight: null
            };

            var DOMAIN_RECORD_2_NEW = {
                id: 3352894,
                type: 'TXT',
                name: '@',
                data: 'somethingnew',
                priority: null,
                port: null,
                weight: null
            };

            var DOMAIN_RECORD_3_NEW = {
                id: 3352895,
                type: 'TXT',
                name: '@',
                data: 'thirdnewone',
                priority: null,
                port: null,
                weight: null
            };

            var req1 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .get('/v2/domains/' + config.zoneName() + '/records')
                .reply(200, { domain_records: [ DOMAIN_RECORD_0, DOMAIN_RECORD_1, DOMAIN_RECORD_2 ] });
            var req2 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .put('/v2/domains/' + config.zoneName() + '/records/' + DOMAIN_RECORD_1.id)
                .reply(200, { domain_record: DOMAIN_RECORD_1_NEW });
            var req3 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .put('/v2/domains/' + config.zoneName() + '/records/' + DOMAIN_RECORD_2.id)
                .reply(200, { domain_record: DOMAIN_RECORD_2_NEW });
            var req4 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .post('/v2/domains/' + config.zoneName() + '/records')
                .reply(201, { domain_record: DOMAIN_RECORD_2_NEW });

            domains.upsertDNSRecords('', DOMAIN_0.domain, 'TXT', [ DOMAIN_RECORD_2_NEW.data, DOMAIN_RECORD_1_NEW.data, DOMAIN_RECORD_3_NEW.data ], function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.eql('3352893');
                expect(req1.isDone()).to.be.ok();
                expect(req2.isDone()).to.be.ok();
                expect(req3.isDone()).to.be.ok();
                expect(req4.isDone()).to.be.ok();

                done();
            });
        });

        it('get succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = {
                id: 3352892,
                type: 'A',
                name: '@',
                data: '1.2.3.4',
                priority: null,
                port: null,
                weight: null
            };

            var DOMAIN_RECORD_1 = {
                id: 3352893,
                type: 'A',
                name: 'test',
                data: '1.2.3.4',
                priority: null,
                port: null,
                weight: null
            };

            var req1 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .get('/v2/domains/' + config.zoneName() + '/records')
                .reply(200, { domain_records: [ DOMAIN_RECORD_0, DOMAIN_RECORD_1 ] });

            domains.getDNSRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.eql(1);
                expect(result[0]).to.eql(DOMAIN_RECORD_1.data);
                expect(req1.isDone()).to.be.ok();

                done();
            });
        });

        it('del succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = {
                id: 3352892,
                type: 'A',
                name: '@',
                data: '1.2.3.4',
                priority: null,
                port: null,
                weight: null
            };

            var DOMAIN_RECORD_1 = {
                id: 3352893,
                type: 'A',
                name: 'test',
                data: '1.2.3.4',
                priority: null,
                port: null,
                weight: null
            };

            var req1 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .get('/v2/domains/' + config.zoneName() + '/records')
                .reply(200, { domain_records: [ DOMAIN_RECORD_0, DOMAIN_RECORD_1 ] });
            var req2 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .delete('/v2/domains/' + config.zoneName() + '/records/' + DOMAIN_RECORD_1.id)
                .reply(204, {});

            domains.removeDNSRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(req1.isDone()).to.be.ok();
                expect(req2.isDone()).to.be.ok();

                done();
            });
        });
    });

    describe('route53', function () {
        // do not clear this with [] but .length = 0 so we don't loose the reference in mockery
        var awsAnswerQueue = [];

        var AWS_HOSTED_ZONES = null;

        before(function (done) {
            DOMAIN_0.provider = 'route53';
            DOMAIN_0.config = {
                accessKeyId: 'unused',
                secretAccessKey: 'unused'
            };

            AWS_HOSTED_ZONES = {
                HostedZones: [{
                    Id: '/hostedzone/Z34G16B38TNZ9L',
                    Name: config.zoneName() + '.',
                    CallerReference: '305AFD59-9D73-4502-B020-F4E6F889CB30',
                    ResourceRecordSetCount: 2,
                    ChangeInfo: {
                        Id: '/change/CKRTFJA0ANHXB',
                        Status: 'INSYNC'
                    }
                }, {
                    Id: '/hostedzone/Z3OFC3B6E8YTA7',
                    Name: 'cloudron.us.',
                    CallerReference: '0B37F2DE-21A4-E678-BA32-3FC8AF0CF635',
                    Config: {},
                    ResourceRecordSetCount: 2,
                    ChangeInfo: {
                        Id: '/change/C2682N5HXP0BZ5',
                        Status: 'INSYNC'
                    }
                }],
                IsTruncated: false,
                MaxItems: '100'
            };

            function mockery (queue) {
                return function(options, callback) {
                    expect(options).to.be.an(Object);

                    var elem = queue.shift();
                    if (!util.isArray(elem)) throw(new Error('Mock answer required'));

                    // if no callback passed, return a req object with send();
                    if (typeof callback !== 'function') {
                        return {
                            httpRequest: { headers: {} },
                            send: function (callback) {
                                expect(callback).to.be.a(Function);
                                callback(elem[0], elem[1]);
                            }
                        };
                    } else {
                        callback(elem[0], elem[1]);
                    }
                };
            }

            function Route53Mock(cfg) {
                expect(cfg).to.eql({
                    accessKeyId: DOMAIN_0.config.accessKeyId,
                    secretAccessKey: DOMAIN_0.config.secretAccessKey,
                    region: 'us-east-1'
                });
            }
            Route53Mock.prototype.getHostedZone = mockery(awsAnswerQueue);
            Route53Mock.prototype.getChange = mockery(awsAnswerQueue);
            Route53Mock.prototype.changeResourceRecordSets = mockery(awsAnswerQueue);
            Route53Mock.prototype.listResourceRecordSets = mockery(awsAnswerQueue);
            Route53Mock.prototype.listHostedZones = mockery(awsAnswerQueue);

            // override route53 in AWS
            // Comment this out and replace the config with real tokens to test against AWS proper
            AWS._originalRoute53 = AWS.Route53;
            AWS.Route53 = Route53Mock;

            domains.update(DOMAIN_0.domain, DOMAIN_0.provider, DOMAIN_0.config, null, done);
        });

        after(function () {
            AWS.Route53 = AWS._originalRoute53;
            delete AWS._originalRoute53;
        });

        it('upsert non-existing record succeeds', function (done) {
            awsAnswerQueue.push([null, AWS_HOSTED_ZONES]);
            awsAnswerQueue.push([null, {
                ChangeInfo: {
                    Id: '/change/C2QLKQIWEI0BZF',
                    Status: 'PENDING',
                    SubmittedAt: 'Mon Aug 04 2014 17: 44: 49 GMT - 0700(PDT)'
                }
            }]);

            domains.upsertDNSRecords('test', DOMAIN_0.domain, 'A', [ '1.2.3.4' ], function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.eql('/change/C2QLKQIWEI0BZF');
                expect(awsAnswerQueue.length).to.eql(0);

                done();
            });
        });

        it('upsert existing record succeeds', function (done) {
            awsAnswerQueue.push([null, AWS_HOSTED_ZONES]);
            awsAnswerQueue.push([null, {
                ChangeInfo: {
                    Id: '/change/C2QLKQIWEI0BZF',
                    Status: 'PENDING',
                    SubmittedAt: 'Mon Aug 04 2014 17: 44: 49 GMT - 0700(PDT)'
                }
            }]);

            domains.upsertDNSRecords('test', DOMAIN_0.domain, 'A', [ '1.2.3.4' ], function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.eql('/change/C2QLKQIWEI0BZF');
                expect(awsAnswerQueue.length).to.eql(0);

                done();
            });
        });

        it('upsert multiple record succeeds', function (done) {
            awsAnswerQueue.push([null, AWS_HOSTED_ZONES]);
            awsAnswerQueue.push([null, {
                ChangeInfo: {
                    Id: '/change/C2QLKQIWEI0BZF',
                    Status: 'PENDING',
                    SubmittedAt: 'Mon Aug 04 2014 17: 44: 49 GMT - 0700(PDT)'
                }
            }]);

            domains.upsertDNSRecords('', DOMAIN_0.domain, 'TXT', [ 'first', 'second', 'third' ], function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.eql('/change/C2QLKQIWEI0BZF');
                expect(awsAnswerQueue.length).to.eql(0);

                done();
            });
        });

        it('get succeeds', function (done) {
            awsAnswerQueue.push([null, AWS_HOSTED_ZONES]);
            awsAnswerQueue.push([null, {
                ResourceRecordSets: [{
                    Name: 'test.' + config.zoneName() + '.',
                    Type: 'A',
                    ResourceRecords: [{
                        Value: '1.2.3.4'
                    }]
                }]
            }]);

            domains.getDNSRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.eql(1);
                expect(result[0]).to.eql('1.2.3.4');
                expect(awsAnswerQueue.length).to.eql(0);

                done();
            });
        });

        it('del succeeds', function (done) {
            awsAnswerQueue.push([null, AWS_HOSTED_ZONES]);
            awsAnswerQueue.push([null, {
                ChangeInfo: {
                    Id: '/change/C2QLKQIWEI0BZF',
                    Status: 'PENDING',
                    SubmittedAt: 'Mon Aug 04 2014 17: 44: 49 GMT - 0700(PDT)'
                }
            }]);

            domains.removeDNSRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(awsAnswerQueue.length).to.eql(0);

                done();
            });
        });
    });

    describe('gcdns', function () {
        var HOSTED_ZONES = [];
        var zoneQueue = [];
        var _OriginalGCDNS;

        before(function (done) {
            DOMAIN_0.provider = 'gcdns';
            DOMAIN_0.config = {
                projectId: 'my-dns-proj',
                keyFilename: __dirname + '/syn-im-1ec6f9f870bf.json'
            };

            function mockery (queue) {
                return function() {
                    var callback = arguments[--arguments.length];

                    var elem = queue.shift();
                    if (!util.isArray(elem)) throw(new Error('Mock answer required'));

                    // if no callback passed, return a req object with send();
                    if (typeof callback !== 'function') {
                        return {
                            httpRequest: { headers: {} },
                            send: function (callback) {
                                expect(callback).to.be.a(Function);
                                callback.apply(callback, elem);
                            }
                        };
                    } else {
                        callback.apply(callback, elem);
                    }
                };
            }

            function fakeZone(name, ns, recordQueue) {
                var zone = GCDNS().zone(name.replace('.', '-'));
                zone.metadata.dnsName = name + '.';
                zone.metadata.nameServers = ns || ['8.8.8.8', '8.8.4.4'];
                zone.getRecords = mockery(recordQueue || zoneQueue);
                zone.createChange = mockery(recordQueue || zoneQueue);
                zone.replaceRecords = mockery(recordQueue || zoneQueue);
                zone.deleteRecords = mockery(recordQueue || zoneQueue);
                return zone;
            }
            HOSTED_ZONES = [ fakeZone(DOMAIN_0.domain), fakeZone('cloudron.us') ];

            _OriginalGCDNS = GCDNS.prototype.getZones;
            GCDNS.prototype.getZones = mockery(zoneQueue);

            domains.update(DOMAIN_0.domain, DOMAIN_0.provider, DOMAIN_0.config, null, done);
        });

        after(function () {
            GCDNS.prototype.getZones = _OriginalGCDNS;
            _OriginalGCDNS = null;
        });

        it('upsert non-existing record succeeds', function (done) {
            zoneQueue.push([null, HOSTED_ZONES]); // getZone
            zoneQueue.push([null, [ ]]); // getRecords
            zoneQueue.push([null, {id: '1'}]);

            domains.upsertDNSRecords('test', DOMAIN_0.domain, 'A', [ '1.2.3.4' ], function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.eql('1');
                expect(zoneQueue.length).to.eql(0);

                done();
            });
        });

        it('upsert existing record succeeds', function (done) {
            zoneQueue.push([null, HOSTED_ZONES]);
            zoneQueue.push([null, [GCDNS().zone('test').record('A', {'name': 'test', data:['5.6.7.8'], ttl: 1})]]);
            zoneQueue.push([null, {id: '2'}]);

            domains.upsertDNSRecords('test', DOMAIN_0.domain, 'A', [ '1.2.3.4' ], function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.eql('2');
                expect(zoneQueue.length).to.eql(0);

                done();
            });
        });

        it('upsert multiple record succeeds', function (done) {
            zoneQueue.push([null, HOSTED_ZONES]);
            zoneQueue.push([null, [ ]]); // getRecords
            zoneQueue.push([null, {id: '3'}]);

            domains.upsertDNSRecords('', DOMAIN_0.domain, 'TXT', [ 'first', 'second', 'third' ], function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.eql('3');
                expect(zoneQueue.length).to.eql(0);

                done();
            });
        });

        it('get succeeds', function (done) {
            zoneQueue.push([null, HOSTED_ZONES]);
            zoneQueue.push([null, [GCDNS().zone('test').record('A', {'name': 'test', data:['1.2.3.4', '5.6.7.8'], ttl: 1})]]);

            domains.getDNSRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.eql(2);
                expect(result).to.eql(['1.2.3.4', '5.6.7.8']);
                expect(zoneQueue.length).to.eql(0);

                done();
            });
        });

        it('del succeeds', function (done) {
            zoneQueue.push([null, HOSTED_ZONES]);
            zoneQueue.push([null, [GCDNS().zone('test').record('A', {'name': 'test', data:['5.6.7.8'], ttl: 1})]]);
            zoneQueue.push([null, {id: '5'}]);

            domains.removeDNSRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(zoneQueue.length).to.eql(0);

                done();
            });
        });
    });
});
