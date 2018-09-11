/* global it:false */
/* global describe:false */
/* global before:false */
/* global after:false */

'use strict';

var async = require('async'),
    database = require('../database.js'),
    domains = require('../domains.js'),
    expect = require('expect.js'),
    reverseProxy = require('../reverseproxy.js'),
    settings = require('../settings.js');

const DOMAIN_0 = {
    domain: 'example-reverseproxy-test.com',
    zoneName: 'example-reverseproxy-test.com',
    provider: 'noop',
    config: {},
    fallbackCertificate: null,
    tlsConfig: { provider: 'fallback' }
};

function setup(done) {
    async.series([
        database.initialize,
        settings.initialize,
        database._clear,
        domains.add.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig)
    ], done);
}

function cleanup(done) {
    async.series([
        database._clear,
        database.uninitialize
    ], done);
}

describe('Certificates', function () {
    describe('validateCertificate', function () {
        /*
          Generate these with:
            openssl genrsa -out server.key 512
            openssl req -new -key server.key -out server.csr -subj "/C=DE/ST=Berlin/L=Berlin/O=Nebulon/OU=CTO/CN=baz.foobar.com"
            openssl x509 -req -days 1460 -in server.csr -signkey server.key -out server.crt
        */

        // foobar.com
        var validCert0 = '-----BEGIN CERTIFICATE-----\nMIIBujCCAWQCCQDuY8krIDA+KzANBgkqhkiG9w0BAQsFADBkMQswCQYDVQQGEwJE\nRTEPMA0GA1UECAwGQmVybGluMQ8wDQYDVQQHDAZCZXJsaW4xEDAOBgNVBAoMB05l\nYnVsb24xDDAKBgNVBAsMA0NUTzETMBEGA1UEAwwKZm9vYmFyLmNvbTAeFw0xNjEx\nMDgwODI2MTRaFw0yMDExMDcwODI2MTRaMGQxCzAJBgNVBAYTAkRFMQ8wDQYDVQQI\nDAZCZXJsaW4xDzANBgNVBAcMBkJlcmxpbjEQMA4GA1UECgwHTmVidWxvbjEMMAoG\nA1UECwwDQ1RPMRMwEQYDVQQDDApmb29iYXIuY29tMFwwDQYJKoZIhvcNAQEBBQAD\nSwAwSAJBALmlwGXb1B9OzZIE9E6eKG1pZJ3P6Sy2tNAWiQ0658uyZhD1udGMNGM1\nRs9IRX+J5p+rAlPglNiG/ArOZtIES8MCAwEAATANBgkqhkiG9w0BAQsFAANBAER1\nxTRc7NQxYYhwld2/gIW5nBJMel7LxYzNlDCbRo1T8a7K6Y4kugORKFidyTjIbsAP\n84gnjmQl9NvBmv33yFk=\n-----END CERTIFICATE-----';
        var validKey0 = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBALmlwGXb1B9OzZIE9E6eKG1pZJ3P6Sy2tNAWiQ0658uyZhD1udGM\nNGM1Rs9IRX+J5p+rAlPglNiG/ArOZtIES8MCAwEAAQJAZhXVVK2rWYP12uPKjCjA\nRln8MCOSLzpQ91RNDO9lY0bIpU+9YfKyyeEPWvFKsvBPTFaS0nyGIiZYIoYoZpCJ\nsQIhAODmkO+UsKTmGKMHqvvmN1Am9zisbiwLqw1F/5g/q6PfAiEA01GhntKZ6vqp\nhihca3tEZKDA3URI/axHTxLKCnp4tJ0CIDFu3Gqcrxr/rGihNdb6aiwG9I4TcH/j\n7KwVN7H6RLrXAiEAyDhtKP2kJncPznRJdPEbkTia5EtB2VC1U9+anSkDWyUCICLn\ngje2pXjZfRtcp49uM/WrQhBifrpuqFSIrLNU3Eb5\n-----END RSA PRIVATE KEY-----';

        // *.foobar.com
        var validCert1 = '-----BEGIN CERTIFICATE-----\nMIIBvjCCAWgCCQDLKYLGisj0djANBgkqhkiG9w0BAQsFADBmMQswCQYDVQQGEwJE\nRTEPMA0GA1UECAwGQmVybGluMQ8wDQYDVQQHDAZCZXJsaW4xEDAOBgNVBAoMB05l\nYnVsb24xDDAKBgNVBAsMA0NUTzEVMBMGA1UEAwwMKi5mb29iYXIuY29tMB4XDTE2\nMTEwODA4MjcxNloXDTIwMTEwNzA4MjcxNlowZjELMAkGA1UEBhMCREUxDzANBgNV\nBAgMBkJlcmxpbjEPMA0GA1UEBwwGQmVybGluMRAwDgYDVQQKDAdOZWJ1bG9uMQww\nCgYDVQQLDANDVE8xFTATBgNVBAMMDCouZm9vYmFyLmNvbTBcMA0GCSqGSIb3DQEB\nAQUAA0sAMEgCQQDXApN6RG4Q6VqJbPsfZNin29V57giGmA81icZFiU0ARv8V0SRF\nShRqPo7iem+0mfH3PgGmauOP+xEu6rFJbZQPAgMBAAEwDQYJKoZIhvcNAQELBQAD\nQQAZxeVrCNoXIs4jtCxgyTDoyFM5IGkq1dlM2CvZW+z3JV8ReCJOw1OEVgd0jIQs\nqZtqd7CQqyWiPMk/QhNInlEd\n-----END CERTIFICATE-----';
        var validKey1 = '-----BEGIN RSA PRIVATE KEY-----\nMIIBPAIBAAJBANcCk3pEbhDpWols+x9k2Kfb1XnuCIaYDzWJxkWJTQBG/xXRJEVK\nFGo+juJ6b7SZ8fc+AaZq44/7ES7qsUltlA8CAwEAAQJBAMyD1MgeQxuu+8FwekXY\nZQT15E9AjbeI+B6S2JfYC/hP0AcGldmQ03KD8N497OOwuagEOZcGdS1eU45E224l\n6DECIQD+yLV6K7BUISdnIXvjkmjkwm1pQNWh4T5o3dArW4Hi+wIhANgJRaF5tbBF\ntYbFzdaDwkPlQurtUM5il/Trci9Q7Sb9AiEA+s2Wn2HcXKSaRhIXA2j/apjd3Ste\nYND6f35CSjv0+vsCIBrIg35ydWkGK2wrB8rpiOMcAEDZ7SO5K3es3PoqwUwNAiEA\n1CAqYa+GI9vDIwDJuInK3k/u4VlsiQiPdjoBySI+bDY=\n-----END RSA PRIVATE KEY-----';

        // baz.foobar.com
        var validCert2 = '-----BEGIN CERTIFICATE-----\nMIIBwjCCAWwCCQCZjm6jL50XfTANBgkqhkiG9w0BAQsFADBoMQswCQYDVQQGEwJE\nRTEPMA0GA1UECAwGQmVybGluMQ8wDQYDVQQHDAZCZXJsaW4xEDAOBgNVBAoMB05l\nYnVsb24xDDAKBgNVBAsMA0NUTzEXMBUGA1UEAwwOYmF6LmZvb2Jhci5jb20wHhcN\nMTYxMTA4MDgyMDE1WhcNMjAxMTA3MDgyMDE1WjBoMQswCQYDVQQGEwJERTEPMA0G\nA1UECAwGQmVybGluMQ8wDQYDVQQHDAZCZXJsaW4xEDAOBgNVBAoMB05lYnVsb24x\nDDAKBgNVBAsMA0NUTzEXMBUGA1UEAwwOYmF6LmZvb2Jhci5jb20wXDANBgkqhkiG\n9w0BAQEFAANLADBIAkEAtKoyTPrf2DjKbnW7Xr1HbRvV+quHTcGmUq5anDI7G4w/\nabqDXGYyakHHlPyZxYp7FWQxCm83rHUuDT1LiLIBZQIDAQABMA0GCSqGSIb3DQEB\nCwUAA0EAVaD2Q6bF9hcUUBev5NyjaMdDYURuWfjuwWUkb8W50O2ed3O+MATKrDdS\nyVaBy8W02KJ4Y1ym4je/MF8nilPurA==\n-----END CERTIFICATE-----';
        var validKey2 = '-----BEGIN RSA PRIVATE KEY-----\nMIIBPQIBAAJBALSqMkz639g4ym51u169R20b1fqrh03BplKuWpwyOxuMP2m6g1xm\nMmpBx5T8mcWKexVkMQpvN6x1Lg09S4iyAWUCAwEAAQJBAJXu7YHPbjfuoalcUZzF\nbuKRCFtZQRf5z0Os6QvZ8A3iR0SzYJzx+c2ibp7WdifMXp3XaKm4tHSOfumrjUIq\nt10CIQDrs9Xo7bq0zuNjUV5IshNfaiYKZRfQciRVW2O8xBP9VwIhAMQ5CCEDZy+u\nsaF9RtmB0bjbe6XonBlAzoflfH/MAwWjAiEA50hL+ohr0MfCMM7DKaozgEj0kvan\n645VQLywnaX5x3kCIQDCwjinS9FnKmV0e/uOd6PJb0/S5IXLKt/TUpu33K5DMQIh\nAM9peu3B5t9pO59MmeUGZwI+bEJfEb+h03WTptBxS3pO\n-----END RSA PRIVATE KEY-----';

        // cp /etc/ssl/openssl.cnf /tmp/openssl.cnf
        // echo -e "[SAN]\nsubjectAltName=DNS:amazing.com,DNS:*.amazing.com\n" >> /tmp/openssl.cnf
        // openssl req -x509 -newkey rsa:2048 -keyout amazing.key -out amazing.crt -days 3650 -subj /CN=*.amazing.com -nodes -extensions SAN -config /tmp/openssl.cnf
        var validCert3 = '-----BEGIN CERTIFICATE-----\nMIIC3DCCAcSgAwIBAgIJALcStAD5sDWEMA0GCSqGSIb3DQEBCwUAMBgxFjAUBgNV\nBAMMDSouYW1hemluZy5jb20wHhcNMTgwMjA5MjIxMzM2WhcNMjgwMjA3MjIxMzM2\nWjAYMRYwFAYDVQQDDA0qLmFtYXppbmcuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOC\nAQ8AMIIBCgKCAQEAvp8dk13u4vmAfKfRNOO8+rVQ8q+vyR8scc9Euj0pTodLBflM\n2K6Zk0isirRzCL/jd4n1A6QrPeJ+r2J4xtHk2j+pavt8Sa2Go2MzpAe3OTuIqYJf\nUt7Im3f2Lb67itTPrpA2TR3A/dDFlazju+eBd3t3496Do8aBPpXAdOabfPsrv3nE\nx97vrr4tzeK3kG9u7GYuod5gyiwF2t5wSeMWbFk2oqkOCtHRXE77JDKVxIGiepnU\nTnkW9b7jIkiBQ1x0xHG4soewV2ymGHS2XrUHZ45FFMG7yVYpytKT9Iz9ty/z5VcL\nZ6NzgU/pKfQaIe8MpoDpVf5UNeB2DOAAEoJKKwIDAQABoykwJzAlBgNVHREEHjAc\nggthbWF6aW5nLmNvbYINKi5hbWF6aW5nLmNvbTANBgkqhkiG9w0BAQsFAAOCAQEA\nMULk6B9XrVPAole8W66o3WUUOrC7NVjbwZjr+Kp5oQTSo84qacaZS2C3ox/j/TZY\nUuNvoE6gIOHi+inN+G4P76K7NEvm8+Y1CeAyaPq01H4Qy2lk9F5wFMtPqvBZnF9C\nx1MvV30FruHXe5pDfnG1npKECpn2SgE3k6FRHM55u8rTMEm/O4TtsDq+fPqUvyWa\nZuRjPv4qVGGkoPyxA6iffxclpOAXs3JUgLcYoM2vxKC0YSOjHEa0p4uffX063Jgg\nybuy3OKvm+8L6moycX7J+LZK81dDTFDtF7PwrnRbpS4re0i/LSk23jDQvDOLnrAa\nSawRR8+1QHTENBo7dnP+NA==\n-----END CERTIFICATE-----';
        var validKey3 = '-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC+nx2TXe7i+YB8\np9E047z6tVDyr6/JHyxxz0S6PSlOh0sF+UzYrpmTSKyKtHMIv+N3ifUDpCs94n6v\nYnjG0eTaP6lq+3xJrYajYzOkB7c5O4ipgl9S3sibd/YtvruK1M+ukDZNHcD90MWV\nrOO754F3e3fj3oOjxoE+lcB05pt8+yu/ecTH3u+uvi3N4reQb27sZi6h3mDKLAXa\n3nBJ4xZsWTaiqQ4K0dFcTvskMpXEgaJ6mdROeRb1vuMiSIFDXHTEcbiyh7BXbKYY\ndLZetQdnjkUUwbvJVinK0pP0jP23L/PlVwtno3OBT+kp9Boh7wymgOlV/lQ14HYM\n4AASgkorAgMBAAECggEAdVSVLMcNqlGuv4vAHtDq2lpOaAKxrZbtkWPlxsisqzRl\nfljT7y+RQfHimkG16LXL+iFFWadsIlxOY/+1nZNGTPwQeNQwzVzs2ZbPC3DgW28E\nkGm56NVOHzu4oLGc2DhjWOxVMCRXTSN66sUPK/K0YunxgqXM2zrtBKvCWXI0VLlo\nN/UWAwHf4i0GWRl8u8PvxgMXlSW9p9l6gSsivWRMag9ADwRQ/NSKrRYkiOoRe3vz\nLxXARBvzeZXvOPVLGVRX4SIR7OmS8cC6Ol/rp1/ZFFID7aN+wdzphPSL1UNUriw4\nDv1mxz73SNakgeYSFBoWRS5BsJI01JoCoILsnhVCiQKBgQDyW+k5+j4K17fzwsmi\nyxZ0Nz/ncpkqxVrWYZM3pn7OVkb2NDArimEk53kmJ0hrT84kKJUYDx55R2TpnzpV\nMLmjxgs9TUrzZzsL/DP2ppkfE3OrPS+06OGa5GbURxD6KPvqDtOmU3oFyJ3f4YJR\nVK7RW+zO4sXEpHIxwdBXbYov1QKBgQDJWbt+W5M0sA2D5LrUBNMTvMdNnKH0syc2\nZlcIOdj6HuUIveYpBRq64Jn9VJpXMxQanwE+IUjCpPTa8wF0OA6MZPy6cfovqb8a\ni1/M/lvCoYVS3KHLcTOvTGD3xej0EUj13xWGNu8y3i7Z9/Bl21hEyjd0q0I5OqJx\no9Qa5TGR/wKBgBPfkYpdiMTe14i3ik09FgRFm4nhDcpCEKbPrYC8uF03Ge6KbQDF\nAh5ClN6aDggurRqt8Tvd0YPkZNP7aI8fxbk2PimystiuuFrNPX2WP6warjt2cvkE\nt6s522zAvxWkUrPor1ZONg1PXBLFrSf6J7OnNA3q7oina23FFM52fwRZAoGAZ7l7\nFffU2IKNI9HT0N7/YZ6RSVEUOXuFCsgjs5AhT5BUynERPTZs87I6gb9wltUwWRpq\nSHhbBDJ4FMa0jAtIq1hmvSF0EdOvJ9x+qJqr6JLOnMYd7zDMwFRna5yfigPRgx+9\n9dsc1CaTGiRYyg/5484MTWTgA51KC6Kq5IQHSj8CgYBr9rWgqM8hVCKSt1cMguQV\nTPaV97+u3kV2jFd/aVgDtCDIVvp5TPuqfskE1v3MsSjJ8hfHdYvyxZB8h8T4LlTD\n2HdxwCjVh2qirAvkar2b1mfA6R8msmVaIxBu4MqDcIPqR823klF7A8jSD3MGzYcU\nbnnxMdwgWQkmx0/6/90ZCg==\n-----END PRIVATE KEY-----\n';

        it('does not allow empty string for cert', function () {
            expect(reverseProxy.validateCertificate('foobar.com', '', 'key')).to.be.an(Error);
        });

        it('does not allow empty string for key', function () {
            expect(reverseProxy.validateCertificate('foobar.com', 'cert', '')).to.be.an(Error);
        });

        it('does not allow invalid cert', function () {
            expect(reverseProxy.validateCertificate('foobar.com', 'someinvalidcert', validKey0)).to.be.an(Error);
        });

        it('does not allow invalid key', function () {
            expect(reverseProxy.validateCertificate('foobar.com', validCert0, 'invalidkey')).to.be.an(Error);
        });

        it('does not allow cert without matching domain', function () {
            expect(reverseProxy.validateCertificate('cloudron.io', validCert0, validKey0)).to.be.an(Error);
        });

        it('allows valid cert with matching domain', function () {
            expect(reverseProxy.validateCertificate('foobar.com', validCert0, validKey0)).to.be(null);
        });

        it('allows valid cert with matching domain (wildcard)', function () {
            expect(reverseProxy.validateCertificate('abc.foobar.com', validCert1, validKey1)).to.be(null);
        });

        it('does now allow cert without matching domain (wildcard)', function () {
            expect(reverseProxy.validateCertificate('foobar.com', validCert1, validKey1)).to.be.an(Error);
            expect(reverseProxy.validateCertificate('bar.abc.foobar.com', validCert1, validKey1)).to.be.an(Error);
        });

        it('allows valid cert with matching domain (subdomain)', function () {
            expect(reverseProxy.validateCertificate('baz.foobar.com', validCert2, validKey2)).to.be(null);
        });

        it('does not allow cert without matching domain (subdomain)', function () {
            expect(reverseProxy.validateCertificate('baz.foobar.com', validCert0, validKey0)).to.be.an(Error);
        });

        it('does not allow invalid cert/key tuple', function () {
            expect(reverseProxy.validateCertificate('foobar.com', validCert0, validKey1)).to.be.an(Error);
        });

        it('picks certificate in SAN', function () {
            expect(reverseProxy.validateCertificate('amazing.com', validCert3, validKey3)).to.be(null);
            expect(reverseProxy.validateCertificate('subdomain.amazing.com', validCert3, validKey3)).to.be(null);
        });
    });

    describe('getApi - caas', function () {
        before(function (done) {
            DOMAIN_0.tlsConfig = { provider: 'caas' };

            async.series([
                setup,
                domains.update.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig)
            ], done);
        });

        after(cleanup);

        it('returns prod caas for prod cloudron', function (done) {
            reverseProxy._getCertApi(DOMAIN_0.domain, function (error, api, options) {
                expect(error).to.be(null);
                expect(api._name).to.be('caas');
                expect(options.prod).to.be(true);
                done();
            });
        });

        it('returns prod caas for dev cloudron', function (done) {
            reverseProxy._getCertApi(DOMAIN_0.domain, function (error, api, options) {
                expect(error).to.be(null);
                expect(api._name).to.be('caas');
                expect(options.prod).to.be(true);
                done();
            });
        });
    });

    describe('getApi - letsencrypt-prod', function () {
        before(function (done) {
            DOMAIN_0.tlsConfig = { provider: 'letsencrypt-prod' };

            async.series([
                setup,
                domains.update.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig)
            ], done);
        });

        after(cleanup);

        it('returns prod acme in prod cloudron', function (done) {
            reverseProxy._getCertApi(DOMAIN_0.domain, function (error, api, options) {
                expect(error).to.be(null);
                expect(api._name).to.be('acme');
                expect(options.prod).to.be(true);
                done();
            });
        });

        it('returns prod acme in dev cloudron', function (done) {
            reverseProxy._getCertApi(DOMAIN_0.domain, function (error, api, options) {
                expect(error).to.be(null);
                expect(api._name).to.be('acme');
                expect(options.prod).to.be(true);
                done();
            });
        });
    });

    describe('getApi - letsencrypt-staging', function () {
        before(function (done) {
            DOMAIN_0.tlsConfig = { provider: 'letsencrypt-staging' };

            async.series([
                setup,
                domains.update.bind(null, DOMAIN_0.domain, DOMAIN_0.zoneName, DOMAIN_0.provider, DOMAIN_0.config, DOMAIN_0.fallbackCertificate, DOMAIN_0.tlsConfig)
            ], done);
        });

        after(cleanup);

        it('returns staging acme in prod cloudron', function (done) {
            reverseProxy._getCertApi(DOMAIN_0.domain, function (error, api, options) {
                expect(error).to.be(null);
                expect(api._name).to.be('acme');
                expect(options.prod).to.be(false);
                done();
            });
        });

        it('returns staging acme in dev cloudron', function (done) {
            reverseProxy._getCertApi(DOMAIN_0.domain, function (error, api, options) {
                expect(error).to.be(null);
                expect(api._name).to.be('acme');
                expect(options.prod).to.be(false);
                done();
            });
        });
    });
});
