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
    namecheap = require('namecheap'),
    nock = require('nock'),
    sinon = require('sinon'),
    util = require('util');

var DOMAIN_0 = {
    domain: 'example-dns-test.com',
    zoneName: 'example-dns-test.com',
    provider: 'noop',
    config: {},
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

var AUDIT_SOURCE = { ip: '1.2.3.4' };

describe('dns provider', function () {
    before(function (done) {
        config._reset();
        config.setFqdn(DOMAIN_0.domain);

        async.series([
            database.initialize,
            database._clear,
            domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE)
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
            DOMAIN_0.provider = 'noop';
            DOMAIN_0.config = {};

            domains.update(DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE, done);
        });

        it('upsert succeeds', function (done) {
            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);

                done();
            });
        });

        it('get succeeds', function (done) {
            domains.getDnsRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.eql(0);

                done();
            });
        });

        it('del succeeds', function (done) {
            domains.removeDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
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

            domains.update(DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE, done);
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
                .get('/v2/domains/' + DOMAIN_0.zoneName + '/records')
                .reply(200, { domain_records: [] });
            var req2 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .post('/v2/domains/' + DOMAIN_0.zoneName + '/records')
                .reply(201, { domain_record: DOMAIN_RECORD_0 });

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
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
                .get('/v2/domains/' + DOMAIN_0.zoneName + '/records')
                .reply(200, { domain_records: [DOMAIN_RECORD_0, DOMAIN_RECORD_1] });
            var req2 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .put('/v2/domains/' + DOMAIN_0.zoneName + '/records/' + DOMAIN_RECORD_1.id)
                .reply(200, { domain_record: DOMAIN_RECORD_1_NEW });

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'A', [DOMAIN_RECORD_1_NEW.data], function (error) {
                expect(error).to.eql(null);
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
                .get('/v2/domains/' + DOMAIN_0.zoneName + '/records')
                .reply(200, { domain_records: [DOMAIN_RECORD_0, DOMAIN_RECORD_1, DOMAIN_RECORD_2] });
            var req2 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .put('/v2/domains/' + DOMAIN_0.zoneName + '/records/' + DOMAIN_RECORD_1.id)
                .reply(200, { domain_record: DOMAIN_RECORD_1_NEW });
            var req3 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .put('/v2/domains/' + DOMAIN_0.zoneName + '/records/' + DOMAIN_RECORD_2.id)
                .reply(200, { domain_record: DOMAIN_RECORD_2_NEW });
            var req4 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .post('/v2/domains/' + DOMAIN_0.zoneName + '/records')
                .reply(201, { domain_record: DOMAIN_RECORD_2_NEW });

            domains.upsertDnsRecords('', DOMAIN_0.domain, 'TXT', [DOMAIN_RECORD_2_NEW.data, DOMAIN_RECORD_1_NEW.data, DOMAIN_RECORD_3_NEW.data], function (error) {
                expect(error).to.eql(null);
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
                .get('/v2/domains/' + DOMAIN_0.zoneName + '/records')
                .reply(200, { domain_records: [DOMAIN_RECORD_0, DOMAIN_RECORD_1] });

            domains.getDnsRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
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
                .get('/v2/domains/' + DOMAIN_0.zoneName + '/records')
                .reply(200, { domain_records: [DOMAIN_RECORD_0, DOMAIN_RECORD_1] });
            var req2 = nock(DIGITALOCEAN_ENDPOINT).filteringRequestBody(function () { return false; })
                .delete('/v2/domains/' + DOMAIN_0.zoneName + '/records/' + DOMAIN_RECORD_1.id)
                .reply(204, {});

            domains.removeDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(req1.isDone()).to.be.ok();
                expect(req2.isDone()).to.be.ok();

                done();
            });
        });
    });

    describe('godaddy', function () {
        var KEY = 'somekey', SECRET = 'somesecret';
        var GODADDY_API = 'https://api.godaddy.com/v1/domains';

        before(function (done) {
            DOMAIN_0.provider = 'godaddy';
            DOMAIN_0.config = {
                apiKey: KEY,
                apiSecret: SECRET
            };

            domains.update(DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE, done);
        });

        it('upsert record succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = [{
                ttl: 600,
                data: '1.2.3.4'
            }];

            var req1 = nock(GODADDY_API)
                .put('/' + DOMAIN_0.zoneName + '/records/A/test', DOMAIN_RECORD_0)
                .reply(200, {});

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(req1.isDone()).to.be.ok();

                done();
            });
        });

        it('get succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = [{
                ttl: 600,
                data: '1.2.3.4'
            }];

            var req1 = nock(GODADDY_API)
                .get('/' + DOMAIN_0.zoneName + '/records/A/test')
                .reply(200, DOMAIN_RECORD_0);

            domains.getDnsRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.eql(1);
                expect(result[0]).to.eql(DOMAIN_RECORD_0[0].data);
                expect(req1.isDone()).to.be.ok();

                done();
            });
        });

        it('del succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = [{ // existing
                ttl: 600,
                data: '1.2.3.4'
            }];

            var DOMAIN_RECORD_1 = [{ // replaced
                ttl: 600,
                data: '0.0.0.0'
            }];

            var req1 = nock(GODADDY_API)
                .get('/' + DOMAIN_0.zoneName + '/records/A/test')
                .reply(200, DOMAIN_RECORD_0);

            var req2 = nock(GODADDY_API)
                .put('/' + DOMAIN_0.zoneName + '/records/A/test', DOMAIN_RECORD_1)
                .reply(200, {});

            domains.removeDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(req1.isDone()).to.be.ok();
                expect(req2.isDone()).to.be.ok();

                done();
            });
        });
    });

    describe('gandi', function () {
        var TOKEN = 'sometoken';
        var GANDI_API = 'https://dns.api.gandi.net/api/v5';

        before(function (done) {
            DOMAIN_0.provider = 'gandi';
            DOMAIN_0.config = {
                token: TOKEN
            };

            domains.update(DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE, done);
        });

        it('upsert record succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = {
                'rrset_ttl': 300,
                'rrset_values': ['1.2.3.4']
            };

            var req1 = nock(GANDI_API)
                .put('/domains/' + DOMAIN_0.zoneName + '/records/test/A', DOMAIN_RECORD_0)
                .reply(201, { message: 'Zone Record Created' });

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(req1.isDone()).to.be.ok();

                done();
            });
        });

        it('get succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = {
                'rrset_type': 'A',
                'rrset_ttl': 600,
                'rrset_name': 'test',
                'rrset_values': ['1.2.3.4']
            };

            var req1 = nock(GANDI_API)
                .get('/domains/' + DOMAIN_0.zoneName + '/records/test/A')
                .reply(200, DOMAIN_RECORD_0);

            domains.getDnsRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.eql(1);
                expect(result[0]).to.eql(DOMAIN_RECORD_0.rrset_values[0]);
                expect(req1.isDone()).to.be.ok();

                done();
            });
        });

        it('del succeeds', function (done) {
            nock.cleanAll();

            var req2 = nock(GANDI_API)
                .delete('/domains/' + DOMAIN_0.zoneName + '/records/test/A')
                .reply(204, {});

            domains.removeDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(req2.isDone()).to.be.ok();

                done();
            });
        });
    });

    describe('name.com', function () {
        const TOKEN = 'sometoken';
        const NAMECOM_API = 'https://api.name.com/v4';

        before(function (done) {
            DOMAIN_0.provider = 'namecom';
            DOMAIN_0.config = {
                username: 'fake',
                token: TOKEN
            };

            domains.update(DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE, done);
        });

        it('upsert record succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = {
                host: 'test',
                type: 'A',
                answer: '1.2.3.4',
                ttl: 300
            };

            var req1 = nock(NAMECOM_API)
                .get(`/domains/${DOMAIN_0.zoneName}/records`)
                .reply(200, { records: [] });

            var req2 = nock(NAMECOM_API)
                .post(`/domains/${DOMAIN_0.zoneName}/records`, DOMAIN_RECORD_0)
                .reply(200, {});

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(req1.isDone()).to.be.ok();
                expect(req2.isDone()).to.be.ok();

                done();
            });
        });

        it('get succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = {
                host: 'test',
                type: 'A',
                answer: '1.2.3.4',
                ttl: 300
            };

            var req1 = nock(NAMECOM_API)
                .get(`/domains/${DOMAIN_0.zoneName}/records`)
                .reply(200, { records: [DOMAIN_RECORD_0] });

            domains.getDnsRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
                expect(error).to.eql(null);
                expect(result).to.be.an(Array);
                expect(result.length).to.eql(1);
                expect(result[0]).to.eql(DOMAIN_RECORD_0.answer);
                expect(req1.isDone()).to.be.ok();

                done();
            });
        });

        it('del succeeds', function (done) {
            nock.cleanAll();

            var DOMAIN_RECORD_0 = {
                id: 'someid',
                host: 'test',
                type: 'A',
                answer: '1.2.3.4',
                ttl: 300
            };

            var req1 = nock(NAMECOM_API)
                .get(`/domains/${DOMAIN_0.zoneName}/records`)
                .reply(200, { records: [DOMAIN_RECORD_0] });

            var req2 = nock(NAMECOM_API)
                .delete(`/domains/${DOMAIN_0.zoneName}/records/${DOMAIN_RECORD_0.id}`)
                .reply(200, {});

            domains.removeDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(req1.isDone()).to.be.ok();
                expect(req2.isDone()).to.be.ok();

                done();
            });
        });
    });

    xdescribe('namecheap', function () {
        let sandbox = require('sinon').createSandbox();

        let username = 'namecheapuser';
        let apiKey = 'API_KEY';

        before(function (done) {
            DOMAIN_0.provider = 'namecheap';
            DOMAIN_0.config = {
                username,
                apiKey
            };

            domains.update(DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE, done);
        });

        after(function() {
            sandbox.restore();
        });

        it('upsert non-existing record succeeds', function (done) {

            let getHostsReturn = {
                'Type': 'namecheap.domains.dns.getHosts',
                'DomainDNSGetHostsResult': {
                    'Domain': 'example-dns-test.com',
                    'EmailType': 'FWD',
                    'IsUsingOurDNS': 'true',
                    'host': [
                        {
                            'HostId': '614433',
                            'Name': 'www',
                            'Type': 'CNAME',
                            'Address': 'parkingpage.namecheap.com.',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': '',
                            'FriendlyName': 'CNAME Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        },
                        {
                            'HostId': '614432',
                            'Name': '@',
                            'Type': 'URL',
                            'Address': 'http://www.example-dns-test.com/',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': 'URL Forwarding',
                            'FriendlyName': 'URL Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        }
                    ]
                }
            };

            let setInternalExpect = [
                {
                    'HostId': '614433',
                    'HostName': 'www',
                    'RecordType': 'CNAME',
                    'Address': 'parkingpage.namecheap.com.',
                    'MXPref': '10',
                    'TTL': '1800',
                    'AssociatedAppTitle': '',
                    'FriendlyName': 'CNAME Record',
                    'IsActive': 'true',
                    'IsDDNSEnabled': 'false'
                },
                {
                    'HostId': '614432',
                    'HostName': '@',
                    'RecordType': 'URL',
                    'Address': 'http://www.example-dns-test.com/',
                    'MXPref': '10',
                    'TTL': '1800',
                    'AssociatedAppTitle': 'URL Forwarding',
                    'FriendlyName': 'URL Record',
                    'IsActive': 'true',
                    'IsDDNSEnabled': 'false'
                },
                {
                    RecordType: 'A',
                    HostName: 'test',
                    Address: '1.2.3.4'
                }
            ];

            let getHostsFake = sinon.fake.yields(null, getHostsReturn);
            let setHostsFake = sinon.fake.yields(null, true);
            let mockObj = {
                dns: {
                    getHosts: getHostsFake,
                    setHosts: setHostsFake
                }
            };

            sandbox.stub(namecheap.prototype, 'domains').value(mockObj);

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);

                expect(setHostsFake.calledOnce).to.eql(true);
                expect(setHostsFake.calledWith(DOMAIN_0.domain, setInternalExpect)).to.eql(true);

                done();
            });
        });

        it('upsert multiple non-existing records succeeds', function (done) {

            let getHostsReturn = {
                'Type': 'namecheap.domains.dns.getHosts',
                'DomainDNSGetHostsResult': {
                    'Domain': 'example-dns-test.com',
                    'EmailType': 'FWD',
                    'IsUsingOurDNS': 'true',
                    'host': [
                        {
                            'HostId': '614433',
                            'Name': 'www',
                            'Type': 'CNAME',
                            'Address': 'parkingpage.namecheap.com.',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': '',
                            'FriendlyName': 'CNAME Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        },
                        {
                            'HostId': '614432',
                            'Name': '@',
                            'Type': 'URL',
                            'Address': 'http://www.example-dns-test.com/',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': 'URL Forwarding',
                            'FriendlyName': 'URL Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        }
                    ]
                }
            };

            let setInternalExpect = [
                {
                    'HostId': '614433',
                    'HostName': 'www',
                    'RecordType': 'CNAME',
                    'Address': 'parkingpage.namecheap.com.',
                    'MXPref': '10',
                    'TTL': '1800',
                    'AssociatedAppTitle': '',
                    'FriendlyName': 'CNAME Record',
                    'IsActive': 'true',
                    'IsDDNSEnabled': 'false'
                },
                {
                    'HostId': '614432',
                    'HostName': '@',
                    'RecordType': 'URL',
                    'Address': 'http://www.example-dns-test.com/',
                    'MXPref': '10',
                    'TTL': '1800',
                    'AssociatedAppTitle': 'URL Forwarding',
                    'FriendlyName': 'URL Record',
                    'IsActive': 'true',
                    'IsDDNSEnabled': 'false'
                },
                {
                    RecordType: 'TXT',
                    HostName: 'test',
                    Address: '1.2.3.4'
                },
                {
                    RecordType: 'TXT',
                    HostName: 'test',
                    Address: '2.3.4.5'
                },
                {
                    RecordType: 'TXT',
                    HostName: 'test',
                    Address: '3.4.5.6'
                }
            ];

            let getHostsFake = sinon.fake.yields(null, getHostsReturn);
            let setHostsFake = sinon.fake.yields(null, true);
            let mockObj = {
                dns: {
                    getHosts: getHostsFake,
                    setHosts: setHostsFake
                }
            };

            sandbox.stub(namecheap.prototype, 'domains').value(mockObj);

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'TXT', ['1.2.3.4', '2.3.4.5', '3.4.5.6'], function (error) {
                expect(error).to.eql(null);

                expect(setHostsFake.calledOnce).to.eql(true);
                expect(setHostsFake.calledWith(DOMAIN_0.domain, setInternalExpect)).to.eql(true);

                done();
            });
        });

        it('upsert multiple non-existing MX records succeeds', function (done) {

            let getHostsReturn = {
                'Type': 'namecheap.domains.dns.getHosts',
                'DomainDNSGetHostsResult': {
                    'Domain': 'example-dns-test.com',
                    'EmailType': 'FWD',
                    'IsUsingOurDNS': 'true',
                    'host': [
                        {
                            'HostId': '614433',
                            'Name': 'www',
                            'Type': 'CNAME',
                            'Address': 'parkingpage.namecheap.com.',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': '',
                            'FriendlyName': 'CNAME Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        },
                        {
                            'HostId': '614432',
                            'Name': '@',
                            'Type': 'URL',
                            'Address': 'http://www.example-dns-test.com/',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': 'URL Forwarding',
                            'FriendlyName': 'URL Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        }
                    ]
                }
            };

            let setInternalExpect = [
                {
                    'HostId': '614433',
                    'HostName': 'www',
                    'RecordType': 'CNAME',
                    'Address': 'parkingpage.namecheap.com.',
                    'MXPref': '10',
                    'TTL': '1800',
                    'AssociatedAppTitle': '',
                    'FriendlyName': 'CNAME Record',
                    'IsActive': 'true',
                    'IsDDNSEnabled': 'false'
                },
                {
                    'HostId': '614432',
                    'HostName': '@',
                    'RecordType': 'URL',
                    'Address': 'http://www.example-dns-test.com/',
                    'MXPref': '10',
                    'TTL': '1800',
                    'AssociatedAppTitle': 'URL Forwarding',
                    'FriendlyName': 'URL Record',
                    'IsActive': 'true',
                    'IsDDNSEnabled': 'false'
                },
                {
                    RecordType: 'MX',
                    HostName: 'test',
                    Address: '1.2.3.4',
                    MXPref: '10'
                },
                {
                    RecordType: 'MX',
                    HostName: 'test',
                    Address: '2.3.4.5',
                    MXPref: '20'
                },
                {
                    RecordType: 'MX',
                    HostName: 'test',
                    Address: '3.4.5.6',
                    MXPref: '30'
                }
            ];

            let getHostsFake = sinon.fake.yields(null, getHostsReturn);
            let setHostsFake = sinon.fake.yields(null, true);
            let mockObj = {
                dns: {
                    getHosts: getHostsFake,
                    setHosts: setHostsFake
                }
            };

            sandbox.stub(namecheap.prototype, 'domains').value(mockObj);

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'MX', ['10 1.2.3.4', '20 2.3.4.5', '30 3.4.5.6'], function (error) {
                expect(error).to.eql(null);

                expect(setHostsFake.calledOnce).to.eql(true);
                expect(setHostsFake.calledWith(DOMAIN_0.domain, setInternalExpect)).to.eql(true);

                done();
            });
        });

        it('upsert existing record succeeds', function (done) {

            let getHostsReturn = {
                'Type': 'namecheap.domains.dns.getHosts',
                'DomainDNSGetHostsResult': {
                    'Domain': 'example-dns-test.com',
                    'EmailType': 'FWD',
                    'IsUsingOurDNS': 'true',
                    'host': [
                        {
                            'HostId': '614433',
                            'Name': 'www',
                            'Type': 'CNAME',
                            'Address': DOMAIN_0.domain,
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': '',
                            'FriendlyName': 'CNAME Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        },
                        {
                            'HostId': '614432',
                            'Name': '@',
                            'Type': 'URL',
                            'Address': 'http://www.example-dns-test.com/',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': 'URL Forwarding',
                            'FriendlyName': 'URL Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        }
                    ]
                }
            };

            let setInternalExpect = [
                {
                    'HostId': '614433',
                    'HostName': 'www',
                    'RecordType': 'CNAME',
                    'Address': '1.2.3.4',
                    'MXPref': '10',
                    'TTL': '1800',
                    'AssociatedAppTitle': '',
                    'FriendlyName': 'CNAME Record',
                    'IsActive': 'true',
                    'IsDDNSEnabled': 'false'
                },
                {
                    'HostId': '614432',
                    'HostName': '@',
                    'RecordType': 'URL',
                    'Address': 'http://www.example-dns-test.com/',
                    'MXPref': '10',
                    'TTL': '1800',
                    'AssociatedAppTitle': 'URL Forwarding',
                    'FriendlyName': 'URL Record',
                    'IsActive': 'true',
                    'IsDDNSEnabled': 'false'
                }
            ];

            let getHostsFake = sinon.fake.yields(null, getHostsReturn);
            let setHostsFake = sinon.fake.yields(null, true);
            let mockObj = {
                dns: {
                    getHosts: getHostsFake,
                    setHosts: setHostsFake
                }
            };

            sandbox.stub(namecheap.prototype, 'domains').value(mockObj);

            domains.upsertDnsRecords('www', DOMAIN_0.domain, 'CNAME', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);

                expect(setHostsFake.calledOnce).to.eql(true);
                expect(setHostsFake.calledWith(DOMAIN_0.domain, setInternalExpect)).to.eql(true);

                done();
            });
        });

        it('get succeeds', function(done) {
            let getHostsReturn = {
                'Type': 'namecheap.domains.dns.getHosts',
                'DomainDNSGetHostsResult': {
                    'Domain': 'example-dns-test.com',
                    'EmailType': 'FWD',
                    'IsUsingOurDNS': 'true',
                    'host': [
                        {
                            'HostId': '614433',
                            'Name': 'www',
                            'Type': 'CNAME',
                            'Address': '1.2.3.4',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': '',
                            'FriendlyName': 'CNAME Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        },
                        {
                            'HostId': '614432',
                            'Name': 'test',
                            'Type': 'A',
                            'Address': '1.2.3.4',
                            'MXPref': '10',
                            'TTL': '1800',
                            'FriendlyName': 'A Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        },
                        {
                            'HostId': '614431',
                            'Name': 'test',
                            'Type': 'A',
                            'Address': '2.3.4.5',
                            'MXPref': '10',
                            'TTL': '1800',
                            'FriendlyName': 'A Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        }
                    ]
                }
            };

            let getHostsFake = sinon.fake.yields(null, getHostsReturn);
            let mockObj = {
                dns: {
                    getHosts: getHostsFake
                }
            };

            sandbox.stub(namecheap.prototype, 'domains').value(mockObj);

            domains.getDnsRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
                expect(error).to.eql(null);

                expect(result).to.be.an(Array);
                expect(result.length).to.eql(2);
                expect(getHostsFake.calledOnce).to.eql(true);
                expect(result).to.eql(['1.2.3.4', '2.3.4.5']);

                done();
            });
        });

        it('del succeeds', function (done) {

            let getHostsReturn = {
                'Type': 'namecheap.domains.dns.getHosts',
                'DomainDNSGetHostsResult': {
                    'Domain': 'example-dns-test.com',
                    'EmailType': 'FWD',
                    'IsUsingOurDNS': 'true',
                    'host': [
                        {
                            'HostId': '614433',
                            'Name': 'www',
                            'Type': 'CNAME',
                            'Address': '1.2.3.4',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': '',
                            'FriendlyName': 'CNAME Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        },
                        {
                            'HostId': '614432',
                            'Name': '@',
                            'Type': 'URL',
                            'Address': 'http://www.example-dns-test.com/',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': 'URL Forwarding',
                            'FriendlyName': 'URL Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        }
                    ]
                }
            };

            let setInternalExpect = [
                {
                    'HostId': '614432',
                    'HostName': '@',
                    'RecordType': 'URL',
                    'Address': 'http://www.example-dns-test.com/',
                    'MXPref': '10',
                    'TTL': '1800',
                    'AssociatedAppTitle': 'URL Forwarding',
                    'FriendlyName': 'URL Record',
                    'IsActive': 'true',
                    'IsDDNSEnabled': 'false'
                }
            ];

            let getHostsFake = sinon.fake.yields(null, getHostsReturn);
            let setHostsFake = sinon.fake.yields(null, true);
            let mockObj = {
                dns: {
                    getHosts: getHostsFake,
                    setHosts: setHostsFake
                }
            };

            sandbox.stub(namecheap.prototype, 'domains').value(mockObj);

            domains.removeDnsRecords('www', DOMAIN_0.domain, 'CNAME', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);

                expect(setHostsFake.calledOnce).to.eql(true);
                expect(setHostsFake.calledWith(DOMAIN_0.domain, setInternalExpect)).to.eql(true);

                done();
            });
        });

        it('del succeeds w/ non-present host', function (done) {

            let getHostsReturn = {
                'Type': 'namecheap.domains.dns.getHosts',
                'DomainDNSGetHostsResult': {
                    'Domain': 'example-dns-test.com',
                    'EmailType': 'FWD',
                    'IsUsingOurDNS': 'true',
                    'host': [
                        {
                            'HostId': '614433',
                            'Name': 'www',
                            'Type': 'CNAME',
                            'Address': 'parkingpage.namecheap.com.',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': '',
                            'FriendlyName': 'CNAME Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        },
                        {
                            'HostId': '614432',
                            'Name': '@',
                            'Type': 'URL',
                            'Address': 'http://www.example-dns-test.com/',
                            'MXPref': '10',
                            'TTL': '1800',
                            'AssociatedAppTitle': 'URL Forwarding',
                            'FriendlyName': 'URL Record',
                            'IsActive': 'true',
                            'IsDDNSEnabled': 'false'
                        }
                    ]
                }
            };

            let getHostsFake = sinon.fake.yields(null, getHostsReturn);
            let setHostsFake = sinon.fake.yields(null, true);
            let mockObj = {
                dns: {
                    getHosts: getHostsFake,
                    setHosts: setHostsFake
                }
            };

            sandbox.stub(namecheap.prototype, 'domains').value(mockObj);

            domains.removeDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);

                expect(setHostsFake.notCalled).to.eql(true);

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
                    Name: DOMAIN_0.zoneName + '.',
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

            function mockery(queue) {
                return function (options, callback) {
                    expect(options).to.be.an(Object);

                    var elem = queue.shift();
                    if (!util.isArray(elem)) throw (new Error('Mock answer required'));

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
            Route53Mock.prototype.listHostedZonesByName = mockery(awsAnswerQueue);

            // override route53 in AWS
            // Comment this out and replace the config with real tokens to test against AWS proper
            AWS._originalRoute53 = AWS.Route53;
            AWS.Route53 = Route53Mock;

            domains.update(DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE, done);
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

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
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

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
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

            domains.upsertDnsRecords('', DOMAIN_0.domain, 'TXT', ['first', 'second', 'third'], function (error) {
                expect(error).to.eql(null);
                expect(awsAnswerQueue.length).to.eql(0);

                done();
            });
        });

        it('get succeeds', function (done) {
            awsAnswerQueue.push([null, AWS_HOSTED_ZONES]);
            awsAnswerQueue.push([null, {
                ResourceRecordSets: [{
                    Name: 'test.' + DOMAIN_0.zoneName + '.',
                    Type: 'A',
                    ResourceRecords: [{
                        Value: '1.2.3.4'
                    }]
                }]
            }]);

            domains.getDnsRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
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

            domains.removeDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(awsAnswerQueue.length).to.eql(0);

                done();
            });
        });
    });

    xdescribe('gcdns', function () {
        var HOSTED_ZONES = [];
        var zoneQueue = [];
        var _OriginalGCDNS;

        before(function (done) {
            DOMAIN_0.provider = 'gcdns';
            DOMAIN_0.config = {
                projectId: 'my-dns-proj',
                credentials: {
                    'client_email': '123456789349-compute@developer.gserviceaccount.com',
                    'private_key': 'privatehushhush'
                }
            };

            function mockery(queue) {
                return function () {
                    var callback = arguments[--arguments.length];

                    var elem = queue.shift();
                    if (!util.isArray(elem)) throw (new Error('Mock answer required'));

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
            HOSTED_ZONES = [fakeZone(DOMAIN_0.domain), fakeZone('cloudron.us')];

            _OriginalGCDNS = GCDNS.prototype.getZones;
            GCDNS.prototype.getZones = mockery(zoneQueue);

            domains.update(DOMAIN_0.domain, DOMAIN_0, AUDIT_SOURCE, done);
        });

        after(function () {
            GCDNS.prototype.getZones = _OriginalGCDNS;
            _OriginalGCDNS = null;
        });

        it('upsert non-existing record succeeds', function (done) {
            zoneQueue.push([null, HOSTED_ZONES]); // getZone
            zoneQueue.push([null, []]); // getRecords
            zoneQueue.push([null, { id: '1' }]);

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(zoneQueue.length).to.eql(0);

                done();
            });
        });

        it('upsert existing record succeeds', function (done) {
            zoneQueue.push([null, HOSTED_ZONES]);
            zoneQueue.push([null, [GCDNS().zone('test').record('A', { 'name': 'test', data: ['5.6.7.8'], ttl: 1 })]]);
            zoneQueue.push([null, { id: '2' }]);

            domains.upsertDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(zoneQueue.length).to.eql(0);

                done();
            });
        });

        it('upsert multiple record succeeds', function (done) {
            zoneQueue.push([null, HOSTED_ZONES]);
            zoneQueue.push([null, []]); // getRecords
            zoneQueue.push([null, { id: '3' }]);

            domains.upsertDnsRecords('', DOMAIN_0.domain, 'TXT', ['first', 'second', 'third'], function (error) {
                expect(error).to.eql(null);
                expect(zoneQueue.length).to.eql(0);

                done();
            });
        });

        it('get succeeds', function (done) {
            zoneQueue.push([null, HOSTED_ZONES]);
            zoneQueue.push([null, [GCDNS().zone('test').record('A', { 'name': 'test', data: ['1.2.3.4', '5.6.7.8'], ttl: 1 })]]);

            domains.getDnsRecords('test', DOMAIN_0.domain, 'A', function (error, result) {
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
            zoneQueue.push([null, [GCDNS().zone('test').record('A', { 'name': 'test', data: ['5.6.7.8'], ttl: 1 })]]);
            zoneQueue.push([null, { id: '5' }]);

            domains.removeDnsRecords('test', DOMAIN_0.domain, 'A', ['1.2.3.4'], function (error) {
                expect(error).to.eql(null);
                expect(zoneQueue.length).to.eql(0);

                done();
            });
        });
    });
});
