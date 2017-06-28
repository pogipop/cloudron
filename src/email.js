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
    smtpTransport = require('nodemailer-smtp-transport'),
    sysinfo = require('./sysinfo.js'),
    util = require('util'),
    _ = require('underscore');

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

function verifyRelay(relay, callback) {
    assert.strictEqual(typeof relay, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (relay.provider === 'cloudron-smtp') return callback();

    var transporter = nodemailer.createTransport(smtpTransport({
        host: relay.host,
        port: relay.port,
        auth: {
            user: relay.username,
            pass: relay.password
        }
    }));

    transporter.verify(function(error) {
       if (error) return callback(new EmailError(EmailError.BAD_FIELD, error.message));

       callback();
   });
}

function getStatus(callback) {
    assert.strictEqual(typeof callback, 'function');

    var digOptions = { server: '127.0.0.1', port: 53, timeout: 5000 };

    var records = {}, relay = {};

    var dkimKey = cloudron.readDkimPublicKeySync();
    if (!dkimKey) return callback(new EmailError(EmailError.INTERNAL_ERROR, new Error('Failed to read dkim public key')));

    function checkDkim(callback) {
        records.dkim = {
            domain: constants.DKIM_SELECTOR + '._domainkey.' + config.fqdn(),
            type: 'TXT',
            expected: '"v=DKIM1; t=s; p=' + dkimKey + '"',
            value: null,
            status: false
        };

        dig.resolve(records.dkim.domain, records.dkim.type, digOptions, function (error, txtRecords) {
            if (error && error.code === 'ENOTFOUND') return callback(null);    // not setup
            if (error) return callback(error);

            if (Array.isArray(txtRecords) && txtRecords.length !== 0) {
                records.dkim.value = txtRecords[0];
                records.dkim.status = (records.dkim.value === records.dkim.expected);
            }

            callback();
        });
    }

    function checkSpf(callback) {
        records.spf = {
            domain: config.fqdn(),
            type: 'TXT',
            value: null,
            expected: '"v=spf1 a:' + config.adminFqdn() + ' ~all"',
            status: false
        };

        // https://agari.zendesk.com/hc/en-us/articles/202952749-How-long-can-my-SPF-record-be-
        dig.resolve(records.spf.domain, records.spf.type, digOptions, function (error, txtRecords) {
            if (error && error.code === 'ENOTFOUND') return callback(null);    // not setup
            if (error) return callback(error);

            if (!Array.isArray(txtRecords)) return callback();

            var i;
            for (i = 0; i < txtRecords.length; i++) {
                if (txtRecords[i].indexOf('"v=spf1 ') !== 0) continue; // not SPF
                records.spf.value = txtRecords[i];
                records.spf.status = records.spf.value.indexOf(' a:' + config.adminFqdn()) !== -1;
                break;
            }

            if (records.spf.status) {
                records.spf.expected = records.spf.value;
            } else if (i !== txtRecords.length) {
                records.spf.expected = '"v=spf1 a:' + config.adminFqdn() + ' ' + records.spf.value.slice('"v=spf1 '.length);
            }

            callback();
        });
    }

    function checkMx(callback) {
        records.mx = {
            domain: config.fqdn(),
            type: 'MX',
            value: null,
            expected: '10 ' + config.mailFqdn() + '.',
            status: false
        };

        dig.resolve(records.mx.domain, records.mx.type, digOptions, function (error, mxRecords) {
            if (error && error.code === 'ENOTFOUND') return callback(null);    // not setup
            if (error) return callback(error);

            if (Array.isArray(mxRecords) && mxRecords.length !== 0) {
                records.mx.status = mxRecords.length == 1 && mxRecords[0].exchange === (config.mailFqdn() + '.');
                records.mx.value = mxRecords.map(function (r) { return r.priority + ' ' + r.exchange; }).join(' ');
            }

            callback();
        });
    }

    function checkDmarc(callback) {
        records.dmarc = {
            domain: '_dmarc.' + config.fqdn(),
            type: 'TXT',
            value: null,
            expected: '"v=DMARC1; p=reject; pct=100"',
            status: false
        };

        dig.resolve(records.dmarc.domain, records.dmarc.type, digOptions, function (error, txtRecords) {
            if (error && error.code === 'ENOTFOUND') return callback(null);    // not setup
            if (error) return callback(error);

            if (Array.isArray(txtRecords) && txtRecords.length !== 0) {
                records.dmarc.value = txtRecords[0];
                records.dmarc.status = (records.dmarc.value === records.dmarc.expected);
            }

            callback();
        });
    }

    function checkPtr(callback) {
        records.ptr = {
            domain: null,
            type: 'PTR',
            value: null,
            expected: config.mailFqdn() + '.',
            status: false
        };

        sysinfo.getPublicIp(function (error, ip) {
            if (error) return callback(error);

            records.ptr.domain = ip.split('.').reverse().join('.') + '.in-addr.arpa';

            dig.resolve(ip, 'PTR', digOptions, function (error, ptrRecords) {
                if (error && error.code === 'ENOTFOUND') return callback(null);    // not setup
                if (error) return callback(error);

                if (Array.isArray(ptrRecords) && ptrRecords.length !== 0) {
                    records.ptr.value = ptrRecords.join(' ');
                    records.ptr.status = ptrRecords.some(function (v) { return v === records.ptr.expected; });
                }

                return callback();
            });
        });
    }

    function checkOutbound25(callback) {
        assert.strictEqual(typeof callback, 'function');

        var smtpServer = _.sample([
            'smtp.gmail.com',
            'smtp.live.com',
            'smtp.mail.yahoo.com',
            'smtp.o2.ie',
            'smtp.comcast.net',
            'outgoing.verizon.net'
        ]);

        relay = {
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
            callback();
        });
        client.on('timeout', function () {
            relay.status = false;
            relay.value = 'Connect to ' + smtpServer + ' timed out';
            client.destroy();
            callback(new Error('Timeout'));
        });
        client.on('error', function (error) {
            relay.status = false;
            relay.value = 'Connect to ' + smtpServer + ' failed: ' + error.message;
            client.destroy();
            callback(error);
        });
    }

    function ignoreError(what, func) {
        return function (callback) {
            func(function (error) {
                if (error) debug('Ignored error - ' + what + ':', error);

                callback();
            });
        };
    }

    async.parallel([
        ignoreError('mx', checkMx),
        ignoreError('spf', checkSpf),
        ignoreError('dmarc', checkDmarc),
        ignoreError('dkim', checkDkim),
        ignoreError('ptr', checkPtr),
        ignoreError('port25', checkOutbound25)
    ], function () {
        callback(null, { dns: records, relay: relay } );
    });
}
