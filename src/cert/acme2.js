'use strict';

var assert = require('assert'),
    async = require('async'),
    crypto = require('crypto'),
    debug = require('debug')('box:cert/acme2'),
    execSync = require('safetydance').child_process.execSync,
    fs = require('fs'),
    path = require('path'),
    paths = require('../paths.js'),
    safe = require('safetydance'),
    superagent = require('superagent'),
    util = require('util'),
    _ = require('underscore');

const CA_PROD_DIRECTORY_URL = 'https://acme-v02.api.letsencrypt.org/directory',
    CA_STAGING_DIRECTORY_URL = 'https://acme-staging-v02.api.letsencrypt.org/directory';

exports = module.exports = {
    getCertificate: getCertificate,

    // testing
    _name: 'acme'
};

function Acme2Error(reason, errorOrMessage) {
    assert.strictEqual(typeof reason, 'string');
    assert(errorOrMessage instanceof Error || typeof errorOrMessage === 'string' || typeof errorOrMessage === 'undefined');

    Error.call(this);
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name;
    this.reason = reason;
    if (typeof errorOrMessage === 'undefined') {
        this.message = reason;
    } else if (typeof errorOrMessage === 'string') {
        this.message = errorOrMessage;
    } else {
        this.message = 'Internal error';
        this.nestedError = errorOrMessage;
    }
}
util.inherits(Acme2Error, Error);
Acme2Error.INTERNAL_ERROR = 'Internal Error';
Acme2Error.EXTERNAL_ERROR = 'External Error';
Acme2Error.ALREADY_EXISTS = 'Already Exists';
Acme2Error.NOT_COMPLETED = 'Not Completed';
Acme2Error.FORBIDDEN = 'Forbidden';

// http://jose.readthedocs.org/en/latest/
// https://www.ietf.org/proceedings/92/slides/slides-92-acme-1.pdf
// https://community.letsencrypt.org/t/list-of-client-implementations/2103

function Acme2(options) {
    assert.strictEqual(typeof options, 'object');

    this.accountKeyPem = null; // Buffer
    this.email = options.email;
    this.keyId = null;
    this.caDirectory = options.prod ? CA_PROD_DIRECTORY_URL : CA_STAGING_DIRECTORY_URL;
    this.directory = {};
}

Acme2.prototype.getNonce = function (callback) {
    superagent.get(this.directory.newNonce).timeout(30 * 1000).end(function (error, response) {
        if (error && !error.response) return callback(error);
        if (response.statusCode !== 204) return callback(new Error('Invalid response code when fetching nonce : ' + response.statusCode));

        return callback(null, response.headers['Replay-Nonce'.toLowerCase()]);
    });
};

// urlsafe base64 encoding (jose)
function urlBase64Encode(string) {
    return string.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64(str) {
    var buf = util.isBuffer(str) ? str : new Buffer(str);
    return urlBase64Encode(buf.toString('base64'));
}

function getModulus(pem) {
    assert(util.isBuffer(pem));

    var stdout = execSync('openssl rsa -modulus -noout', { input: pem, encoding: 'utf8' });
    if (!stdout) return null;
    var match = stdout.match(/Modulus=([0-9a-fA-F]+)$/m);
    if (!match) return null;
    return Buffer.from(match[1], 'hex');
}

Acme2.prototype.sendSignedRequest = function (url, payload, callback) {
    assert.strictEqual(typeof url, 'string');
    assert.strictEqual(typeof payload, 'string');
    assert.strictEqual(typeof callback, 'function');

    assert(util.isBuffer(this.accountKeyPem));

    const that = this;
    let header = {
        url: url,
        alg: 'RS256'
    };

    // keyId is null when registering account
    if (this.keyId) {
        header.kid = this.keyId;
    } else {
        header.jwk = {
            e: b64(Buffer.from([0x01, 0x00, 0x01])), // exponent - 65537
            kty: 'RSA',
            n: b64(getModulus(this.accountKeyPem))
        };
    }

    var payload64 = b64(payload);

    this.getNonce(function (error, nonce) {
        if (error) return callback(error);

        debug('sendSignedRequest: using nonce %s for url %s', nonce, url);

        var protected64 = b64(JSON.stringify(_.extend({ }, header, { nonce: nonce })));

        var signer = crypto.createSign('RSA-SHA256');
        signer.update(protected64 + '.' + payload64, 'utf8');
        var signature64 = urlBase64Encode(signer.sign(that.accountKeyPem, 'base64'));

        var data = {
            protected: protected64,
            payload: payload64,
            signature: signature64
        };

        superagent.post(url).set('Content-Type', 'application/jose+json').set('User-Agent', 'acme-cloudron').send(JSON.stringify(data)).timeout(30 * 1000).end(function (error, res) {
            if (error && !error.response) return callback(error); // network errors

            callback(null, res);
        });
    });
};

Acme2.prototype.updateContact = function (registrationUri, callback) {
    assert.strictEqual(typeof registrationUri, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`updateContact: registrationUri: ${registrationUri} email: ${this.email}`);

    // https://github.com/ietf-wg-acme/acme/issues/30
    const payload = {
        contact: [ 'mailto:' + this.email ]
    };

    const that = this;
    this.sendSignedRequest(registrationUri, JSON.stringify(payload), function (error, result) {
        if (error) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'Network error when registering user: ' + error.message));
        if (result.statusCode !== 200) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, util.format('Failed to update contact. Expecting 200, got %s %s', result.statusCode, result.text)));

        debug(`updateContact: contact of user updated to ${that.email}`);

        callback();
    });
};

Acme2.prototype.registerUser = function (callback) {
    assert.strictEqual(typeof callback, 'function');

    var payload = {
        termsOfServiceAgreed: true
    };

    debug('registerUser: registering user');

    var that = this;
    this.sendSignedRequest(this.directory.newAccount, JSON.stringify(payload), function (error, result) {
        if (error) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'Network error when registering new account: ' + error.message));
        if (result.statusCode !== 200) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, util.format('Failed to register new account. Expecting 200, got %s %s', result.statusCode, result.text)));

        debug(`registerUser: user registered keyid: ${result.headers.location}`);

        that.keyId = result.headers.location;

        that.updateContact(result.headers.location, callback);
    });
};

Acme2.prototype.newOrder = function (domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    var payload = {
        identifiers: [{
            type: 'dns',
            value: domain
        }]
    };

    debug('newOrder: %s', domain);

    this.sendSignedRequest(this.directory.newOrder, JSON.stringify(payload), function (error, result) {
        if (error) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'Network error when registering domain: ' + error.message));
        if (result.statusCode === 403) return callback(new Acme2Error(Acme2Error.FORBIDDEN, result.body.detail));
        if (result.statusCode !== 201) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, util.format('Failed to register user. Expecting 201, got %s %s', result.statusCode, result.text)));

        debug('newOrder: created order %s %j', domain, result.body);

        const order = result.body, orderUrl = result.headers.location;

        if (!Array.isArray(order.authorizations)) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'invalid authorizations in order'));
        if (typeof order.finalize !== 'string') return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'invalid finalize in order'));
        if (typeof orderUrl !== 'string') return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'invalid order location in order header'));

        callback(null, order, orderUrl);
    });
};

Acme2.prototype.waitForOrder = function (orderUrl, callback) {
    assert.strictEqual(typeof orderUrl, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`waitForOrder: ${orderUrl}`);

    async.retry({ times: 10, interval: 5000 }, function (retryCallback) {
        debug('waitForOrder: getting status');

        superagent.get(orderUrl).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) {
                debug('waitForOrder: network error getting uri %s', orderUrl);
                return retryCallback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, error.message)); // network error
            }
            if (result.statusCode !== 200) {
                debug('waitForOrder: invalid response code getting uri %s', result.statusCode);
                return retryCallback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'Bad response code:' + result.statusCode));
            }

            debug('waitForOrder: status is "%s %j', result.body.status, result.body);

            if (result.body.status === 'pending' || result.body.status === 'processing') return retryCallback(new Acme2Error(Acme2Error.NOT_COMPLETED));
            else if (result.body.status === 'valid' && result.body.certificate) return retryCallback(null, result.body.certificate);
            else return retryCallback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'Unexpected status or invalid response: ' + result.body));
        });
    }, callback);
};

Acme2.prototype.prepareHttpChallenge = function (challenge, callback) {
    assert.strictEqual(typeof challenge, 'object'); // { type, status, url, token }
    assert.strictEqual(typeof callback, 'function');

    debug('prepareHttpChallenge: preparing for challenge %j', challenge);

    var token = challenge.token;

    assert(util.isBuffer(this.accountKeyPem));

    var jwk = {
        e: b64(Buffer.from([0x01, 0x00, 0x01])), // Exponent - 65537
        kty: 'RSA',
        n: b64(getModulus(this.accountKeyPem))
    };

    var shasum = crypto.createHash('sha256');
    shasum.update(JSON.stringify(jwk));
    var thumbprint = urlBase64Encode(shasum.digest('base64'));
    var keyAuthorization = token + '.' + thumbprint;

    debug('prepareHttpChallenge: writing %s to %s', keyAuthorization, path.join(paths.ACME_CHALLENGES_DIR, token));

    fs.writeFile(path.join(paths.ACME_CHALLENGES_DIR, token), token + '.' + thumbprint, function (error) {
        if (error) return callback(new Acme2Error(Acme2Error.INTERNAL_ERROR, error));

        callback();
    });
};

Acme2.prototype.notifyChallengeReady = function (challenge, callback) {
    assert.strictEqual(typeof challenge, 'object'); // { type, status, url, token }
    assert.strictEqual(typeof callback, 'function');

    debug('notifyChallengeReady: %s was met', challenge.url);

    var keyAuthorization = fs.readFileSync(path.join(paths.ACME_CHALLENGES_DIR, challenge.token), 'utf8');

    var payload = {
        resource: 'challenge',
        keyAuthorization: keyAuthorization
    };

    this.sendSignedRequest(challenge.url, JSON.stringify(payload), function (error, result) {
        if (error) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'Network error when notifying challenge: ' + error.message));
        if (result.statusCode !== 200) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, util.format('Failed to notify challenge. Expecting 200, got %s %s', result.statusCode, result.text)));

        callback();
    });
};

Acme2.prototype.waitForChallenge = function (challenge, callback) {
    assert.strictEqual(typeof challenge, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('waitingForChallenge: %j', challenge);

    async.retry({ times: 10, interval: 5000 }, function (retryCallback) {
        debug('waitingForChallenge: getting status');

        superagent.get(challenge.url).timeout(30 * 1000).end(function (error, result) {
            if (error && !error.response) {
                debug('waitForChallenge: network error getting uri %s', challenge.url);
                return retryCallback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, error.message)); // network error
            }
            if (result.statusCode !== 200) {
                debug('waitForChallenge: invalid response code getting uri %s', result.statusCode);
                return retryCallback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'Bad response code:' + result.statusCode));
            }

            debug('waitForChallenge: status is "%s %j', result.body.status, result.body);

            if (result.body.status === 'pending') return retryCallback(new Acme2Error(Acme2Error.NOT_COMPLETED));
            else if (result.body.status === 'valid') return retryCallback();
            else return retryCallback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'Unexpected status: ' + result.body.status));
        });
    }, function retryFinished(error) {
        // async.retry will pass 'undefined' as second arg making it unusable with async.waterfall()
        callback(error);
    });
};

// https://community.letsencrypt.org/t/public-beta-rate-limits/4772 for rate limits
Acme2.prototype.signCertificate = function (domain, finalizationUrl, csrDer, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof finalizationUrl, 'string');
    assert(util.isBuffer(csrDer));
    assert.strictEqual(typeof callback, 'function');

    const payload = {
        csr: b64(csrDer)
    };

    debug('signCertificate: sending sign request');

    this.sendSignedRequest(finalizationUrl, JSON.stringify(payload), function (error, result) {
        if (error) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'Network error when signing certificate: ' + error.message));
        // 429 means we reached the cert limit for this domain
        if (result.statusCode !== 200) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, util.format('Failed to sign certificate. Expecting 200, got %s %s', result.statusCode, result.text)));

        return callback(null);
    });
};

Acme2.prototype.createKeyAndCsr = function (domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    var outdir = paths.APP_CERTS_DIR;
    var csrFile = path.join(outdir, domain + '.csr');
    var privateKeyFile = path.join(outdir, domain + '.key');

    if (safe.fs.existsSync(privateKeyFile)) {
        // in some old releases, csr file was corrupt. so always regenerate it
        debug('createKeyAndCsr: reuse the key for renewal at %s', privateKeyFile);
    } else {
        var key = execSync('openssl genrsa 4096');
        if (!key) return callback(new Acme2Error(Acme2Error.INTERNAL_ERROR, safe.error));
        if (!safe.fs.writeFileSync(privateKeyFile, key)) return callback(new Acme2Error(Acme2Error.INTERNAL_ERROR, safe.error));

        debug('createKeyAndCsr: key file saved at %s', privateKeyFile);
    }

    var csrDer = execSync(util.format('openssl req -new -key %s -outform DER -subj /CN=%s', privateKeyFile, domain));
    if (!csrDer) return callback(new Acme2Error(Acme2Error.INTERNAL_ERROR, safe.error));
    if (!safe.fs.writeFileSync(csrFile, csrDer)) return callback(new Acme2Error(Acme2Error.INTERNAL_ERROR, safe.error)); // bookkeeping

    debug('createKeyAndCsr: csr file (DER) saved at %s', csrFile);

    callback(null, csrDer);
};

Acme2.prototype.downloadCertificate = function (domain, certUrl, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof certUrl, 'string');
    assert.strictEqual(typeof callback, 'function');

    var outdir = paths.APP_CERTS_DIR;

    superagent.get(certUrl).buffer().parse(function (res, done) {
        var data = [ ];
        res.on('data', function(chunk) { data.push(chunk); });
        res.on('end', function () { res.text = Buffer.concat(data); done(); });
    }).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'Network error when downloading certificate'));
        if (result.statusCode === 202) return callback(new Acme2Error(Acme2Error.INTERNAL_ERROR, 'Retry not implemented yet'));
        if (result.statusCode !== 200) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, util.format('Failed to get cert. Expecting 200, got %s %s', result.statusCode, result.text)));

        const fullChainPem = result.text;

        var certificateFile = path.join(outdir, domain + '.cert');
        if (!safe.fs.writeFileSync(certificateFile, fullChainPem)) return callback(new Acme2Error(Acme2Error.INTERNAL_ERROR, safe.error));

        debug('downloadCertificate: cert file for %s saved at %s', domain, certificateFile);

        callback();
    });
};

Acme2.prototype.getAuthorization = function (url, callback) {
    superagent.get(url).timeout(30 * 1000).end(function (error, response) {
        if (error && !error.response) return callback(error);
        if (response.statusCode !== 200) return callback(new Error('Invalid response code getting authorization : ' + response.statusCode));

        return callback(null, response.body);
    });
};

Acme2.prototype.acmeFlow = function (domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!fs.existsSync(paths.ACME_ACCOUNT_KEY_FILE)) {
        debug('getCertificate: generating acme account key on first run');
        this.accountKeyPem = safe.child_process.execSync('openssl genrsa 4096');
        if (!this.accountKeyPem) return callback(new Acme2Error(Acme2Error.INTERNAL_ERROR, safe.error));

        safe.fs.writeFileSync(paths.ACME_ACCOUNT_KEY_FILE, this.accountKeyPem);
    } else {
        debug('getCertificate: using existing acme account key');
        this.accountKeyPem = fs.readFileSync(paths.ACME_ACCOUNT_KEY_FILE);
    }

    var that = this;
    this.registerUser(function (error) {
        if (error) return callback(error);

        that.newOrder(domain, function (error, order, orderUrl) {
            if (error) return callback(error);

            async.eachSeries(order.authorizations, function (authorizationUrl, iteratorCallback) {
                debug(`acmeFlow: authorizing ${authorizationUrl}`);

                that.getAuthorization(authorizationUrl, function (error, authorization) {
                    if (error) return iteratorCallback(error);

                    debug('acmeFlow: challenges: %j', authorization);
                    var httpChallenges = authorization.challenges.filter(function(x) { return x.type === 'http-01'; });
                    if (httpChallenges.length === 0) return callback(new Acme2Error(Acme2Error.EXTERNAL_ERROR, 'no http challenges'));
                    var challenge = httpChallenges[0];

                    async.waterfall([
                        that.prepareHttpChallenge.bind(that, challenge),
                        that.notifyChallengeReady.bind(that, challenge),
                        that.waitForChallenge.bind(that, challenge),
                        that.createKeyAndCsr.bind(that, domain),
                        that.signCertificate.bind(that, domain, order.finalize),
                        that.waitForOrder.bind(that, orderUrl),
                        that.downloadCertificate.bind(that, domain)
                    ], iteratorCallback);
                });
            }, callback);
        });
    });
};

Acme2.prototype.getDirectory = function (callback) {
    const that = this;

    superagent.get(this.caDirectory).timeout(30 * 1000).end(function (error, response) {
        if (error && !error.response) return callback(error);
        if (response.statusCode !== 200) return callback(new Error('Invalid response code when fetching directory : ' + response.statusCode));

        if (typeof response.body.newNonce !== 'string'
            || typeof response.body.newOrder !== 'string'
            || typeof response.body.newAccount !== 'string') return callback(new Error(`Invalid response body : ${response.body}`));

        that.directory = response.body;

        callback(null);
    });
};

Acme2.prototype.getCertificate = function (domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`getCertificate: start acme flow for ${domain} from ${this.caDirectory}`);

    const that = this;
    this.getDirectory(function (error) {
        if (error) return callback(error);

        that.acmeFlow(domain, function (error) {
            if (error) return callback(error);

            var outdir = paths.APP_CERTS_DIR;
            callback(null, path.join(outdir, domain + '.cert'), path.join(outdir, domain + '.key'));
        });
    });
};

function getCertificate(domain, options, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    var acme = new Acme2(options || { });
    acme.getCertificate(domain, callback);
}
