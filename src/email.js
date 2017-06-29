'use strict';

exports = module.exports = {
    verifyRelay: verifyRelay,
    getStatus: getStatus,

    EmailError: EmailError
};

var assert = require('assert'),
    async = require('async'),
    cloudron = require('./cloudron.js'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    debug = require('debug')('box:email'),
    dig = require('./dig.js'),
    net = require('net'),
    nodemailer = require('nodemailer'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    smtpTransport = require('nodemailer-smtp-transport'),
    sysinfo = require('./sysinfo.js'),
    util = require('util'),
    _ = require('underscore');

const digOptions = { server: '127.0.0.1', port: 53, timeout: 5000 };

function EmailError(reason, errorOrMessage) {
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
util.inherits(EmailError, Error);
EmailError.INTERNAL_ERROR = 'Internal Error';
EmailError.BAD_FIELD = 'Bad Field';

function checkOutboundPort25(callback) {
    assert.strictEqual(typeof callback, 'function');

    var smtpServer = _.sample([
        'smtp.gmail.com',
        'smtp.live.com',
        'smtp.mail.yahoo.com',
        'smtp.o2.ie',
        'smtp.comcast.net',
        'outgoing.verizon.net'
    ]);

    var relay = {
        value: 'OK',
        status: false
    };

    var client = new net.Socket();
    client.setTimeout(5000);
    client.connect(25, smtpServer);
    client.on('connect', function () {
        relay.status = true;
        relay.value = 'OK';
        client.destroy(); // do not use end() because it still triggers timeout
        callback(null, relay);
    });
    client.on('timeout', function () {
        relay.status = false;
        relay.value = 'Connect to ' + smtpServer + ' timed out';
        client.destroy();
        callback(new Error('Timeout'), relay);
    });
    client.on('error', function (error) {
        relay.status = false;
        relay.value = 'Connect to ' + smtpServer + ' failed: ' + error.message;
        client.destroy();
        callback(error, relay);
    });
}

function checkSmtpRelay(relay, callback) {
    var result = {
        value: 'OK',
        status: false
    };

    var transporter = nodemailer.createTransport(smtpTransport({
        host: relay.host,
        port: relay.port,
        auth: {
            user: relay.username,
            pass: relay.password
        }
    }));

    transporter.verify(function(error) {
        result.status = !error;
        if (error) {
            result.value = error.message;
            return callback(error, result);
        }

       callback(null, result);
    });
}

function verifyRelay(relay, callback) {
    assert.strictEqual(typeof relay, 'object');
    assert.strictEqual(typeof callback, 'function');

    var verifier = relay.provider === 'cloudron-smtp' ? checkOutboundPort25 : checkSmtpRelay.bind(null, relay);

    verifier(function (error) {
        if (error) return callback(new EmailError(EmailError.BAD_FIELD, error.message));

        callback();
    });
}

function checkDkim(callback) {
    var dkim = {
        domain: constants.DKIM_SELECTOR + '._domainkey.' + config.fqdn(),
        type: 'TXT',
        expected: null,
        value: null,
        status: false
    };

    var dkimKey = cloudron.readDkimPublicKeySync();
    if (!dkimKey) return callback(new Error('Failed to read dkim public key'), dkim);

    dkim.expected = '"v=DKIM1; t=s; p=' + dkimKey + '"';

    dig.resolve(dkim.domain, dkim.type, digOptions, function (error, txtRecords) {
        if (error && error.code === 'ENOTFOUND') return callback(null, dkim);    // not setup
        if (error) return callback(error, dkim);

        if (Array.isArray(txtRecords) && txtRecords.length !== 0) {
            dkim.value = txtRecords[0];
            dkim.status = (dkim.value === dkim.expected);
        }

        callback(null, dkim);
    });
}

function checkSpf(callback) {
    var spf = {
        domain: config.fqdn(),
        type: 'TXT',
        value: null,
        expected: '"v=spf1 a:' + config.adminFqdn() + ' ~all"',
        status: false
    };

    // https://agari.zendesk.com/hc/en-us/articles/202952749-How-long-can-my-SPF-record-be-
    dig.resolve(spf.domain, spf.type, digOptions, function (error, txtRecords) {
        if (error && error.code === 'ENOTFOUND') return callback(null, spf);    // not setup
        if (error) return callback(error, spf);

        if (!Array.isArray(txtRecords)) return callback(null, spf);

        var i;
        for (i = 0; i < txtRecords.length; i++) {
            if (txtRecords[i].indexOf('"v=spf1 ') !== 0) continue; // not SPF
            spf.value = txtRecords[i];
            spf.status = spf.value.indexOf(' a:' + config.adminFqdn()) !== -1;
            break;
        }

        if (spf.status) {
            spf.expected = spf.value;
        } else if (i !== txtRecords.length) {
            spf.expected = '"v=spf1 a:' + config.adminFqdn() + ' ' + spf.value.slice('"v=spf1 '.length);
        }

        callback(null, spf);
    });
}

function checkMx(callback) {
    var mx = {
        domain: config.fqdn(),
        type: 'MX',
        value: null,
        expected: '10 ' + config.mailFqdn() + '.',
        status: false
    };

    dig.resolve(mx.domain, mx.type, digOptions, function (error, mxRecords) {
        if (error && error.code === 'ENOTFOUND') return callback(null, mx);    // not setup
        if (error) return callback(error, mx);

        if (Array.isArray(mxRecords) && mxRecords.length !== 0) {
            mx.status = mxRecords.length == 1 && mxRecords[0].exchange === (config.mailFqdn() + '.');
            mx.value = mxRecords.map(function (r) { return r.priority + ' ' + r.exchange; }).join(' ');
        }

        callback(null, mx);
    });
}

function checkDmarc(callback) {
    var dmarc = {
        domain: '_dmarc.' + config.fqdn(),
        type: 'TXT',
        value: null,
        expected: '"v=DMARC1; p=reject; pct=100"',
        status: false
    };

    dig.resolve(dmarc.domain, dmarc.type, digOptions, function (error, txtRecords) {
        if (error && error.code === 'ENOTFOUND') return callback(null, dmarc);    // not setup
        if (error) return callback(error, dmarc);

        if (Array.isArray(txtRecords) && txtRecords.length !== 0) {
            dmarc.value = txtRecords[0];
            dmarc.status = (dmarc.value === dmarc.expected);
        }

        callback(null, dmarc);
    });
}

function checkPtr(callback) {
    var ptr = {
        domain: null,
        type: 'PTR',
        value: null,
        expected: config.mailFqdn() + '.',
        status: false
    };

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(error, ptr);

        ptr.domain = ip.split('.').reverse().join('.') + '.in-addr.arpa';

        dig.resolve(ip, 'PTR', digOptions, function (error, ptrRecords) {
            if (error && error.code === 'ENOTFOUND') return callback(null, ptr);    // not setup
            if (error) return callback(error, ptr);

            if (Array.isArray(ptrRecords) && ptrRecords.length !== 0) {
                ptr.value = ptrRecords.join(' ');
                ptr.status = ptrRecords.some(function (v) { return v === ptr.expected; });
            }

            return callback(null, ptr);
        });
    });
}

function getStatus(callback) {
    assert.strictEqual(typeof callback, 'function');

    var results = {};

    function recordResult(what, func) {
        return function (callback) {
            func(function (error, result) {
                if (error) debug('Ignored error - ' + what + ':', error);

                safe.set(results, what, result);

                callback();
            });
        };
    }

    settings.getMailRelay(function (error, relay) {
        if (error) return callback(error);

        var checks = [
            recordResult('dns.mx', checkMx),
            recordResult('dns.dmarc', checkDmarc)
        ];

        if (relay.provider === 'cloudron-smtp') {
            // these tests currently only make sense when using Cloudron's SMTP server at this point
            checks.push(
                recordResult('dns.spf', checkSpf),
                recordResult('dns.dkim', checkDkim),
                recordResult('dns.ptr', checkPtr),
                recordResult('relay', checkOutboundPort25)
            );
        } else {
            checks.push(recordResult('relay', checkSmtpRelay.bind(null, relay)));
        }

        async.parallel(checks, function () {
            callback(null, results);
        });
    });
}
