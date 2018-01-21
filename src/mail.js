'use strict';

exports = module.exports = {
    verifyRelay: verifyRelay,
    getStatus: getStatus,
    checkRblStatus: checkRblStatus,

    getMailFromValidation: getMailFromValidation,
    setMailFromValidation: setMailFromValidation,

    setCatchAllAddress: setCatchAllAddress,
    getCatchAllAddress: getCatchAllAddress,

    getMailRelay: getMailRelay,
    setMailRelay: setMailRelay,

    getMailConfig: getMailConfig,
    setMailConfig: setMailConfig,

    createMailConfig: createMailConfig,

    MAIL_FROM_VALIDATION_KEY: 'mail_from_validation',
    CATCH_ALL_ADDRESS_KEY: 'catch_all_address',
    MAIL_RELAY_KEY: 'mail_relay',
    MAIL_CONFIG_KEY: 'mail_config',

    MailError: MailError
};

var assert = require('assert'),
    async = require('async'),
    cloudron = require('./cloudron.js'),
    config = require('./config.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:mail'),
    dig = require('./dig.js'),
    net = require('net'),
    nodemailer = require('nodemailer'),
    paths = require('./paths.js'),
    platform = require('./platform.js'),
    safe = require('safetydance'),
    settingsdb = require('./settingsdb.js'),
    smtpTransport = require('nodemailer-smtp-transport'),
    sysinfo = require('./sysinfo.js'),
    user = require('./user.js'),
    util = require('util'),
    _ = require('underscore');

const digOptions = { server: '127.0.0.1', port: 53, timeout: 5000 };
var NOOP_CALLBACK = function (error) { if (error) debug(error); };

var gDefaults = (function () {
    var result = { };
    result[exports.MAIL_FROM_VALIDATION_KEY] = true;
    result[exports.CATCH_ALL_ADDRESS_KEY] = [ ];
    result[exports.MAIL_RELAY_KEY] = { provider: 'cloudron-smtp' };
    result[exports.MAIL_CONFIG_KEY] = { enabled: false };

    return result;
})();

function MailError(reason, errorOrMessage) {
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
util.inherits(MailError, Error);
MailError.INTERNAL_ERROR = 'Internal Error';
MailError.BAD_FIELD = 'Bad Field';

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
        if (error) return callback(new MailError(MailError.BAD_FIELD, error.message));

        callback();
    });
}

function checkDkim(callback) {
    var dkim = {
        domain: config.dkimSelector() + '._domainkey.' + config.fqdn(),
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

// https://raw.githubusercontent.com/jawsome/node-dnsbl/master/list.json
const RBL_LIST = [
    {
        'name': 'Barracuda',
        'dns': 'b.barracudacentral.org',
        'site': 'http://www.barracudacentral.org/rbl/removal-request'
    },
    {
        'name': 'SpamCop',
        'dns': 'bl.spamcop.net',
        'site': 'http://spamcop.net'
    },
    {
        'name': 'Sorbs Aggregate Zone',
        'dns': 'dnsbl.sorbs.net',
        'site': 'http://dnsbl.sorbs.net/'
    },
    {
        'name': 'Sorbs spam.dnsbl Zone',
        'dns': 'spam.dnsbl.sorbs.net',
        'site': 'http://sorbs.net'
    },
    {
        'name': 'Composite Blocking List',
        'dns': 'cbl.abuseat.org',
        'site': 'http://www.abuseat.org'
    },
    {
        'name': 'SpamHaus Zen',
        'dns': 'zen.spamhaus.org',
        'site': 'http://spamhaus.org'
    },
    {
        'name': 'Multi SURBL',
        'dns': 'multi.surbl.org',
        'site': 'http://www.surbl.org'
    },
    {
        'name': 'Spam Cannibal',
        'dns': 'bl.spamcannibal.org',
        'site': 'http://www.spamcannibal.org/cannibal.cgi'
    },
    {
        'name': 'dnsbl.abuse.ch',
        'dns': 'spam.abuse.ch',
        'site': 'http://dnsbl.abuse.ch/'
    },
    {
        'name': 'The Unsubscribe Blacklist(UBL)',
        'dns': 'ubl.unsubscore.com ',
        'site': 'http://www.lashback.com/blacklist/'
    },
    {
        'name': 'UCEPROTECT Network',
        'dns': 'dnsbl-1.uceprotect.net',
        'site': 'http://www.uceprotect.net/en'
    }
];

function checkRblStatus(callback) {
    assert.strictEqual(typeof callback, 'function');

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(error, ip);

        var flippedIp = ip.split('.').reverse().join('.');

        // https://tools.ietf.org/html/rfc5782
        async.map(RBL_LIST, function (rblServer, iteratorDone) {
            dig.resolve(flippedIp + '.' + rblServer.dns, 'A', digOptions, function (error, records) {
                if (error || !records) return iteratorDone(null, null);    // not listed

                debug('checkRblStatus: %s (ip: %s) is in the blacklist of %j', config.fqdn(), flippedIp, rblServer);

                var result = _.extend({ }, rblServer);

                dig.resolve(flippedIp + '.' + rblServer.dns, 'TXT', digOptions, function (error, txtRecords) {
                    result.txtRecords = error || !txtRecords ? 'No txt record' : txtRecords;

                    debug('checkRblStatus: %s (error: %s) (txtRecords: %j)', config.fqdn(), error, txtRecords);

                    return iteratorDone(null, result);
                });
            });
        }, function (ignoredError, blacklistedServers) {
            blacklistedServers = blacklistedServers.filter(function(b) { return b !== null; });

            debug('checkRblStatus: %s (ip: %s) servers: %j', config.fqdn(), ip, blacklistedServers);

            return callback(null, { status: blacklistedServers.length === 0, ip: ip, servers: blacklistedServers });
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

    getMailRelay(function (error, relay) {
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
                recordResult('relay', checkOutboundPort25),
                recordResult('rbl', checkRblStatus)
            );
        } else {
            checks.push(recordResult('relay', checkSmtpRelay.bind(null, relay)));
        }

        async.parallel(checks, function () {
            callback(null, results);
        });
    });
}

// FIXME: temporary function till we move to domain API
function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.getAll(function (error, settings) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        var result = _.extend({ }, gDefaults);
        settings.forEach(function (setting) { result[setting.name] = setting.value; });

        // convert JSON objects
        [ exports.CATCH_ALL_ADDRESS_KEY, exports.MAIL_RELAY_KEY, exports.MAIL_CONFIG_KEY ].forEach(function (key) {
            result[key] = typeof result[key] === 'object' ? result[key] : safe.JSON.parse(result[key]);
        });

        callback(null, result);
    });
}

function createMailConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    const fqdn = config.fqdn();
    const mailFqdn = config.mailFqdn();
    const alertsFrom = 'no-reply@' + config.fqdn();

    debug('createMailConfig: generating mail config');

    user.getOwner(function (error, owner) {
        var alertsTo = config.provider() === 'caas' ? [ 'support@cloudron.io' ] : [ ];
        alertsTo.concat(error ? [] : owner.email).join(','); // owner may not exist yet

        getAll(function (error, result) {
            if (error) return callback(error);

            var catchAll = result[exports.CATCH_ALL_ADDRESS_KEY].map(function (c) { return `${c}@${fqdn}`; }).join(',');
            var mailFromValidation = result[exports.MAIL_FROM_VALIDATION_KEY];

            if (!safe.fs.writeFileSync(paths.ADDON_CONFIG_DIR + '/mail/mail.ini',
                `mail_domains=${fqdn}\nmail_default_domain=${fqdn}\nmail_server_name=${mailFqdn}\nalerts_from=${alertsFrom}\nalerts_to=${alertsTo}\ncatch_all=${catchAll}\nmail_from_validation=${mailFromValidation}\n`, 'utf8')) {
                return callback(new Error('Could not create mail var file:' + safe.error.message));
            }

            var relay = result[exports.MAIL_RELAY_KEY];

            const enabled = relay.provider !== 'cloudron-smtp' ? true : false,
                host = relay.host || '',
                port = relay.port || 25,
                username = relay.username || '',
                password = relay.password || '';

            if (!safe.fs.writeFileSync(paths.ADDON_CONFIG_DIR + '/mail/smtp_forward.ini',
                `enable_outbound=${enabled}\nhost=${host}\nport=${port}\nenable_tls=true\nauth_type=plain\nauth_user=${username}\nauth_pass=${password}`, 'utf8')) {
                return callback(new Error('Could not create mail var file:' + safe.error.message));
            }

            callback();
        });
    });
}

function getMailFromValidation(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.MAIL_FROM_VALIDATION_KEY, function (error, enabled) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.MAIL_FROM_VALIDATION_KEY]);
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null, !!enabled); // settingsdb holds string values only
    });
}

function setMailFromValidation(enabled, callback) {
    assert.strictEqual(typeof enabled, 'boolean');
    assert.strictEqual(typeof callback, 'function');

    settingsdb.set(exports.MAIL_FROM_VALIDATION_KEY, enabled ? 'enabled' : '', function (error) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        createMailConfig(NOOP_CALLBACK);

        callback(null);
    });
}

function getCatchAllAddress(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.CATCH_ALL_ADDRESS_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.CATCH_ALL_ADDRESS_KEY]);
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value));
    });
}

function setCatchAllAddress(address, callback) {
    assert(Array.isArray(address));
    assert.strictEqual(typeof callback, 'function');

    settingsdb.set(exports.CATCH_ALL_ADDRESS_KEY, JSON.stringify(address), function (error) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        createMailConfig(NOOP_CALLBACK);

        callback(null);
    });
}

function getMailRelay(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.MAIL_RELAY_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.MAIL_RELAY_KEY]);
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value));
    });
}

function setMailRelay(relay, callback) {
    assert.strictEqual(typeof relay, 'object');
    assert.strictEqual(typeof callback, 'function');

    verifyRelay(relay, function (error) {
        if (error) return callback(error);

        settingsdb.set(exports.MAIL_RELAY_KEY, JSON.stringify(relay), function (error) {
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            platform.restartMail(NOOP_CALLBACK);

            callback(null);
        });
    });
}


function getMailConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settingsdb.get(exports.MAIL_CONFIG_KEY, function (error, value) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, gDefaults[exports.MAIL_CONFIG_KEY]);
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null, JSON.parse(value));
    });
}

function setMailConfig(mailConfig, callback) {
    assert.strictEqual(typeof mailConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    settingsdb.set(exports.MAIL_CONFIG_KEY, JSON.stringify(mailConfig), function (error) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        platform.restartMail(NOOP_CALLBACK);

        callback(null);
    });
}
