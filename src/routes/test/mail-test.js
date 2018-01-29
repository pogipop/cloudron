'use strict';

/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

var async = require('async'),
    config = require('../../config.js'),
    database = require('../../database.js'),
    expect = require('expect.js'),
    mail = require('../../mail.js'),
    domains = require('../../domains.js'),
    maildb = require('../../maildb.js'),
    server = require('../../server.js'),
    superagent = require('superagent');

var SERVER_URL = 'http://localhost:' + config.get('port');

const DOMAIN_0 = {
    domain: 'example-mail-test.com',
    zoneName: 'example-mail-test.com',
    config: {},
    provider: 'noop',
    fallbackCertificate: null
};
var USERNAME = 'superadmin', PASSWORD = 'Foobar?1337', EMAIL ='silly@me.com';
var token = null;

function setup(done) {
    config._reset();
    config.setFqdn(DOMAIN_0.domain);
    config.setAdminFqdn('my.example-mail-test.com');

    async.series([
        server.start.bind(null),
        database._clear.bind(null),
        domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate),

        function createAdmin(callback) {
            superagent.post(SERVER_URL + '/api/v1/cloudron/activate')
                .query({ setupToken: 'somesetuptoken' })
                .send({ username: USERNAME, password: PASSWORD, email: EMAIL })
                .end(function (error, result) {
                    expect(result).to.be.ok();
                    expect(result.statusCode).to.eql(201);

                    // stash token for further use
                    token = result.body.token;

                    callback();
                });
        }
    ], done);
}

function cleanup(done) {
    database._clear(function (error) {
        expect(!error).to.be.ok();

        server.stop(done);
    });
}

describe('Mail API', function () {
    before(setup);
    after(cleanup);

    describe('crud', function () {
        it('cannot add non-existing domain', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail')
                .query({ access_token: token })
                .send({ domain: 'doesnotexist.com' })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(404);
                    done();
                });
        });

        it('domain must be a string', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail')
                .query({ access_token: token })
                .send({ domain: ['doesnotexist.com'] })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('can add domain', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail')
                .query({ access_token: token })
                .send({ domain: DOMAIN_0.domain })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(201);
                    done();
                });
        });

        it('cannot add domain twice', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail')
                .query({ access_token: token })
                .send({ domain: DOMAIN_0.domain })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(409);
                    done();
                });
        });

        it('cannot get non-existing domain', function (done) {
            superagent.get(SERVER_URL + '/api/v1/mail/doesnotexist.com')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(404);
                    done();
                });
        });

        it('can get domain', function (done) {
            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN_0.domain)
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.domain).to.equal(DOMAIN_0.domain);
                    expect(res.body.enabled).to.equal(false);
                    expect(res.body.mailFromValidation).to.equal(true);
                    expect(res.body.catchAll).to.be.an(Array);
                    expect(res.body.catchAll.length).to.equal(0);
                    expect(res.body.relay).to.be.an('object');
                    expect(res.body.relay.provider).to.equal('cloudron-smtp');
                    done();
                });
        });

        it('cannot delete domain without password', function (done) {
            superagent.del(SERVER_URL + '/api/v1/mail/doesnotexist.com')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot delete domain with wrong password', function (done) {
            superagent.del(SERVER_URL + '/api/v1/mail/doesnotexist.com')
                .send({ password: PASSWORD+PASSWORD })
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(403);
                    done();
                });
        });

        it('cannot delete non-existing domain', function (done) {
            superagent.del(SERVER_URL + '/api/v1/mail/doesnotexist.com')
                .query({ access_token: token })
                .send({ password: PASSWORD })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(404);
                    done();
                });
        });

        it('can delete domain', function (done) {
            superagent.del(SERVER_URL + '/api/v1/mail/' + DOMAIN_0.domain)
                .send({ password: PASSWORD })
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(204);
                    done();
                });
        });
    });

    xdescribe('email DNS records', function () {
        var resolve = null;
        var dnsAnswerQueue = [];
        var dkimDomain, spfDomain, mxDomain, dmarcDomain;

        this.timeout(10000);

        before(function (done) {
            var dig = require('../../dig.js');

            // replace dns resolveTxt()
            resolve = dig.resolve;
            dig.resolve = function (hostname, type, options, callback) {
                expect(hostname).to.be.a('string');
                expect(callback).to.be.a('function');

                if (!dnsAnswerQueue[hostname] || !(type in dnsAnswerQueue[hostname])) return callback(new Error('no mock answer'));

                callback(null, dnsAnswerQueue[hostname][type]);
            };

            dkimDomain = 'cloudron._domainkey.' + DOMAIN_0.domain;
            spfDomain = DOMAIN_0.domain;
            mxDomain = DOMAIN_0.domain;
            dmarcDomain = '_dmarc.' + DOMAIN_0.domain;

            done();
        });

        after(function (done) {
            var dig = require('../../dig.js');

            dig.resolve = resolve;

            done();
        });

        it('does not fail when dns errors', function (done) {
            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN_0.domain + '/status')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    done();
                });
        });

        function clearDnsAnswerQueue() {
            dnsAnswerQueue = { };
            dnsAnswerQueue[dkimDomain] =  { };
            dnsAnswerQueue[spfDomain] =  { };
            dnsAnswerQueue[mxDomain] =  { };
            dnsAnswerQueue[dmarcDomain] =  { };
        }

        it('succeeds with dns errors', function (done) {
            clearDnsAnswerQueue();

            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN_0.domain + '/status')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);

                    expect(res.body.dns.dkim).to.be.an('object');
                    expect(res.body.dns.dkim.domain).to.eql(dkimDomain);
                    expect(res.body.dns.dkim.type).to.eql('TXT');
                    expect(res.body.dns.dkim.value).to.eql(null);
                    expect(res.body.dns.dkim.expected).to.eql('"v=DKIM1; t=s; p=' + mail._readDkimPublicKeySync(DOMAIN_0.domain) + '"');
                    expect(res.body.dns.dkim.status).to.eql(false);

                    expect(res.body.dns.spf).to.be.an('object');
                    expect(res.body.dns.spf.domain).to.eql(spfDomain);
                    expect(res.body.dns.spf.type).to.eql('TXT');
                    expect(res.body.dns.spf.value).to.eql(null);
                    expect(res.body.dns.spf.expected).to.eql('"v=spf1 a:' + config.adminFqdn() + ' ~all"');
                    expect(res.body.dns.spf.status).to.eql(false);

                    expect(res.body.dns.dmarc).to.be.an('object');
                    expect(res.body.dns.dmarc.type).to.eql('TXT');
                    expect(res.body.dns.dmarc.value).to.eql(null);
                    expect(res.body.dns.dmarc.expected).to.eql('"v=DMARC1; p=reject; pct=100"');
                    expect(res.body.dns.dmarc.status).to.eql(false);

                    expect(res.body.dns.mx).to.be.an('object');
                    expect(res.body.dns.mx.type).to.eql('MX');
                    expect(res.body.dns.mx.value).to.eql(null);
                    expect(res.body.dns.mx.expected).to.eql('10 ' + config.mailFqdn() + '.');
                    expect(res.body.dns.mx.status).to.eql(false);

                    expect(res.body.dns.ptr).to.be.an('object');
                    expect(res.body.dns.ptr.type).to.eql('PTR');
                    // expect(res.body.ptr.value).to.eql(null); this will be anything random
                    expect(res.body.dns.ptr.expected).to.eql(config.mailFqdn() + '.');
                    expect(res.body.dns.ptr.status).to.eql(false);

                    done();
                });
        });

        it('succeeds with "undefined" spf, dkim, dmarc, mx, ptr records', function (done) {
            clearDnsAnswerQueue();

            dnsAnswerQueue[dkimDomain].TXT = null;
            dnsAnswerQueue[spfDomain].TXT = null;
            dnsAnswerQueue[mxDomain].MX = null;
            dnsAnswerQueue[dmarcDomain].TXT = null;

            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN_0.domain + '/status')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);

                    expect(res.body.dns.spf).to.be.an('object');
                    expect(res.body.dns.spf.expected).to.eql('"v=spf1 a:' + config.adminFqdn() + ' ~all"');
                    expect(res.body.dns.spf.status).to.eql(false);
                    expect(res.body.dns.spf.value).to.eql(null);

                    expect(res.body.dns.dkim).to.be.an('object');
                    expect(res.body.dns.dkim.expected).to.eql('"v=DKIM1; t=s; p=' + mail._readDkimPublicKeySync(DOMAIN_0.domain) + '"');
                    expect(res.body.dns.dkim.status).to.eql(false);
                    expect(res.body.dns.dkim.value).to.eql(null);

                    expect(res.body.dns.dmarc).to.be.an('object');
                    expect(res.body.dns.dmarc.expected).to.eql('"v=DMARC1; p=reject; pct=100"');
                    expect(res.body.dns.dmarc.status).to.eql(false);
                    expect(res.body.dns.dmarc.value).to.eql(null);

                    expect(res.body.dns.mx).to.be.an('object');
                    expect(res.body.dns.mx.status).to.eql(false);
                    expect(res.body.dns.mx.expected).to.eql('10 ' + config.mailFqdn() + '.');
                    expect(res.body.dns.mx.value).to.eql(null);

                    expect(res.body.dns.ptr).to.be.an('object');
                    expect(res.body.dns.ptr.expected).to.eql(config.mailFqdn() + '.');
                    expect(res.body.dns.ptr.status).to.eql(false);
                    // expect(res.body.ptr.value).to.eql(null); this will be anything random

                    done();
                });
        });

        it('succeeds with all different spf, dkim, dmarc, mx, ptr records', function (done) {
            clearDnsAnswerQueue();

            dnsAnswerQueue[mxDomain].MX = [ { priority: '20', exchange: config.mailFqdn() + '.' }, { priority: '30', exchange: config.mailFqdn() + '.'} ];
            dnsAnswerQueue[dmarcDomain].TXT = ['"v=DMARC2; p=reject; pct=100"'];
            dnsAnswerQueue[dkimDomain].TXT = ['"v=DKIM2; t=s; p=' + mail._readDkimPublicKeySync(DOMAIN_0.domain) + '"'];
            dnsAnswerQueue[spfDomain].TXT = ['"v=spf1 a:random.com ~all"'];

            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN_0.domain + '/status')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);

                    expect(res.body.dns.spf).to.be.an('object');
                    expect(res.body.dns.spf.expected).to.eql('"v=spf1 a:' + config.adminFqdn() + ' a:random.com ~all"');
                    expect(res.body.dns.spf.status).to.eql(false);
                    expect(res.body.dns.spf.value).to.eql('"v=spf1 a:random.com ~all"');

                    expect(res.body.dns.dkim).to.be.an('object');
                    expect(res.body.dns.dkim.expected).to.eql('"v=DKIM1; t=s; p=' + mail._readDkimPublicKeySync(DOMAIN_0.domain) + '"');
                    expect(res.body.dns.dkim.status).to.eql(false);
                    expect(res.body.dns.dkim.value).to.eql('"v=DKIM2; t=s; p=' + mail._readDkimPublicKeySync(DOMAIN_0.domain) + '"');

                    expect(res.body.dns.dmarc).to.be.an('object');
                    expect(res.body.dns.dmarc.expected).to.eql('"v=DMARC1; p=reject; pct=100"');
                    expect(res.body.dns.dmarc.status).to.eql(false);
                    expect(res.body.dns.dmarc.value).to.eql('"v=DMARC2; p=reject; pct=100"');

                    expect(res.body.dns.mx).to.be.an('object');
                    expect(res.body.dns.mx.status).to.eql(false);
                    expect(res.body.dns.mx.expected).to.eql('10 ' + config.mailFqdn() + '.');
                    expect(res.body.dns.mx.value).to.eql('20 ' + config.mailFqdn() + '. 30 ' + config.mailFqdn() + '.');

                    expect(res.body.dns.ptr).to.be.an('object');
                    expect(res.body.dns.ptr.expected).to.eql(config.mailFqdn() + '.');
                    expect(res.body.dns.ptr.status).to.eql(false);
                    // expect(res.body.ptr.value).to.eql(null); this will be anything random

                    expect(res.body.relay).to.be.an('object');

                    done();
                });
        });

        it('succeeds with existing embedded spf', function (done) {
            clearDnsAnswerQueue();

            dnsAnswerQueue[spfDomain].TXT = ['"v=spf1 a:example.com a:' + config.mailFqdn() + ' ~all"'];

            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN_0.domain + '/status')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);

                    expect(res.body.dns.spf).to.be.an('object');
                    expect(res.body.dns.spf.domain).to.eql(spfDomain);
                    expect(res.body.dns.spf.type).to.eql('TXT');
                    expect(res.body.dns.spf.value).to.eql('"v=spf1 a:example.com a:' + config.mailFqdn() + ' ~all"');
                    expect(res.body.dns.spf.expected).to.eql('"v=spf1 a:example.com a:' + config.mailFqdn() + ' ~all"');
                    expect(res.body.dns.spf.status).to.eql(true);

                    done();
                });
        });

        it('succeeds with all correct records', function (done) {
            clearDnsAnswerQueue();

            dnsAnswerQueue[mxDomain].MX = [ { priority: '10', exchange: config.mailFqdn() + '.' } ];
            dnsAnswerQueue[dmarcDomain].TXT = ['"v=DMARC1; p=reject; pct=100"'];
            dnsAnswerQueue[dkimDomain].TXT = ['"v=DKIM1; t=s; p=' + mail._readDkimPublicKeySync(DOMAIN_0.domain) + '"'];
            dnsAnswerQueue[spfDomain].TXT = ['"v=spf1 a:' + config.adminFqdn() + ' ~all"'];

            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN_0.domain + '/status')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);

                    expect(res.body.dns.dkim).to.be.an('object');
                    expect(res.body.dns.dkim.domain).to.eql(dkimDomain);
                    expect(res.body.dns.dkim.type).to.eql('TXT');
                    expect(res.body.dns.dkim.value).to.eql('"v=DKIM1; t=s; p=' + mail._readDkimPublicKeySync(DOMAIN_0.domain) + '"');
                    expect(res.body.dns.dkim.expected).to.eql('"v=DKIM1; t=s; p=' + mail._readDkimPublicKeySync(DOMAIN_0.domain) + '"');
                    expect(res.body.dns.dkim.status).to.eql(true);

                    expect(res.body.dns.spf).to.be.an('object');
                    expect(res.body.dns.spf.domain).to.eql(spfDomain);
                    expect(res.body.dns.spf.type).to.eql('TXT');
                    expect(res.body.dns.spf.value).to.eql('"v=spf1 a:' + config.adminFqdn() + ' ~all"');
                    expect(res.body.dns.spf.expected).to.eql('"v=spf1 a:' + config.adminFqdn() + ' ~all"');
                    expect(res.body.dns.spf.status).to.eql(true);

                    expect(res.body.dns.dmarc).to.be.an('object');
                    expect(res.body.dns.dmarc.expected).to.eql('"v=DMARC1; p=reject; pct=100"');
                    expect(res.body.dns.dmarc.status).to.eql(true);
                    expect(res.body.dns.dmarc.value).to.eql('"v=DMARC1; p=reject; pct=100"');

                    expect(res.body.dns.mx).to.be.an('object');
                    expect(res.body.dns.mx.status).to.eql(true);
                    expect(res.body.dns.mx.expected).to.eql('10 ' + config.mailFqdn() + '.');
                    expect(res.body.dns.mx.value).to.eql('10 ' + config.mailFqdn() + '.');

                    done();
                });
        });
    });

    xdescribe('mail from validation', function () {
        it('get mail from validation succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN_0.domain)
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.mailFromValidation).to.eql(true);
                    done();
                });
        });

        it('cannot set without enabled field', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail/' + DOMAIN + '/mail_from_validation')
                .query({ access_token: token })
                .send({ })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('can set with enabled field', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail/' + DOMAIN + '/mail_from_validation')
                .query({ access_token: token })
                .send({ enabled: false })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);
                    done();
                });
        });
    });

    xdescribe('catch_all', function () {
        it('get catch_all succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN)
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.catchAll).to.eql([ ]);
                    done();
                });
        });

        it('cannot set without address field', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail/' + DOMAIN + '/catch_all')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot set with bad address field', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail/' + DOMAIN + '/catch_all')
                .query({ access_token: token })
                .send({ address: [ 'user1', 123 ] })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('set succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail/' + DOMAIN + '/catch_all')
                .query({ access_token: token })
                .send({ address: [ 'user1' ] })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);
                    done();
                });
        });

        it('get succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN)
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.catchAll).to.eql([ 'user1' ]);
                    done();
                });
        });
    });

    xdescribe('mail relay', function () {
        it('get mail relay succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN)
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.relay).to.eql({ provider: 'cloudron-smtp' });
                    done();
                });
        });

        it('cannot set without provider field', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail/' + DOMAIN + '/relay')
                .query({ access_token: token })
                .send({ })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('cannot set with bad host', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail/' + DOMAIN + '/relay')
                .query({ access_token: token })
                .send({ provider: 'external-smtp', host: true })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('set fails because mail server is unreachable', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail/' + DOMAIN + '/relay')
                .query({ access_token: token })
                .send({ provider: 'external-smtp', host: 'host', port: 25, username: 'u', password: 'p', tls: true })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('get succeeds', function (done) {
            var relay = { provider: 'external-smtp', host: 'host', port: 25, username: 'u', password: 'p', tls: true };

            maildb.update(DOMAIN, { relay: relay }, function (error) { // skip the mail server verify()
                expect(error).to.not.be.ok();

                superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN)
                    .query({ access_token: token })
                    .end(function (err, res) {
                        expect(res.statusCode).to.equal(200);
                        expect(res.body.relay).to.eql(relay);
                        done();
                    });
            });
        });
    });

    xdescribe('mail_config', function () {
        it('get mail_config succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN)
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.enabled).to.be(false);
                    done();
                });
        });

        it('cannot set without enabled field', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail/' + DOMAIN + '/enable')
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(400);
                    done();
                });
        });

        it('set succeeds', function (done) {
            superagent.post(SERVER_URL + '/api/v1/mail/' + DOMAIN + '/enable')
                .query({ access_token: token })
                .send({ enabled: true })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(202);
                    done();
                });
        });

        it('get succeeds', function (done) {
            superagent.get(SERVER_URL + '/api/v1/mail/' + DOMAIN)
                .query({ access_token: token })
                .end(function (err, res) {
                    expect(res.statusCode).to.equal(200);
                    expect(res.body.enabled).to.be(true);
                    done();
                });
        });
    });
});
