'use strict';

exports = module.exports = {
    getStatus: getStatus,

    getDomains: getDomains,

    getDomain: getDomain,
    addDomain: addDomain,
    removeDomain: removeDomain,

    setDnsRecords: setDnsRecords,

    validateName: validateName,

    setMailFromValidation: setMailFromValidation,
    setCatchAllAddress: setCatchAllAddress,
    setMailRelay: setMailRelay,
    setMailEnabled: setMailEnabled,

    startMail: restartMail,

    sendTestMail: sendTestMail,

    getMailboxes: getMailboxes,
    removeMailboxes: removeMailboxes,
    getMailbox: getMailbox,
    addMailbox: addMailbox,
    updateMailbox: updateMailbox,
    removeMailbox: removeMailbox,

    listAliases: listAliases,
    getAliases: getAliases,
    setAliases: setAliases,

    getLists: getLists,
    getList: getList,
    addList: addList,
    updateList: updateList,
    removeList: removeList,

    _readDkimPublicKeySync: readDkimPublicKeySync,

    MailError: MailError
};

var assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:mail'),
    dns = require('./native-dns.js'),
    domains = require('./domains.js'),
    eventlog = require('./eventlog.js'),
    infra = require('./infra_version.js'),
    mailboxdb = require('./mailboxdb.js'),
    maildb = require('./maildb.js'),
    mailer = require('./mailer.js'),
    net = require('net'),
    nodemailer = require('nodemailer'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    reverseProxy = require('./reverseproxy.js'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    smtpTransport = require('nodemailer-smtp-transport'),
    sysinfo = require('./sysinfo.js'),
    users = require('./users.js'),
    util = require('util'),
    _ = require('underscore');

const DNS_OPTIONS = { server: '127.0.0.1', timeout: 5000 }; // unbound runs on 127.0.0.1
var NOOP_CALLBACK = function (error) { if (error) debug(error); };

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
MailError.EXTERNAL_ERROR = 'External Error';
MailError.BAD_FIELD = 'Bad Field';
MailError.ALREADY_EXISTS = 'Already Exists';
MailError.NOT_FOUND = 'Not Found';
MailError.IN_USE = 'In Use';
MailError.BILLING_REQUIRED = 'Billing Required';

function validateName(name) {
    assert.strictEqual(typeof name, 'string');

    if (name.length < 1) return new MailError(MailError.BAD_FIELD, 'mailbox name must be atleast 1 char');
    if (name.length >= 200) return new MailError(MailError.BAD_FIELD, 'mailbox name too long');

    // also need to consider valid LDAP characters here (e.g '+' is reserved)
    if (/[^a-zA-Z0-9.-]/.test(name)) return new MailError(MailError.BAD_FIELD, 'mailbox name can only contain alphanumerals and dot');

    // app emails are sent using the .app suffix
    if (name.indexOf('.app') !== -1) return new MailError(MailError.BAD_FIELD, 'mailbox name pattern is reserved for apps');

    return null;
}

function checkOutboundPort25(callback) {
    assert.strictEqual(typeof callback, 'function');

    var smtpServer = _.sample([
        'smtp.gmail.com',
        'smtp.live.com',
        'smtp.mail.yahoo.com',
        'smtp.o2.ie',
        'smtp.comcast.net',
        'smtp.1und1.de',
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
        connectionTimeout: 5000,
        greetingTimeout: 5000,
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

    // we used to verify cloudron-smtp with checkOutboundPort25 but that is unreliable given that we just
    // randomly select some smtp server
    if (relay.provider === 'cloudron-smtp') return callback();

    checkSmtpRelay(relay, function (error) {
        if (error) return callback(new MailError(MailError.BAD_FIELD, error.message));

        callback();
    });
}

function checkDkim(domain, callback) {
    var dkim = {
        domain: config.dkimSelector() + '._domainkey.' + domain,
        name: config.dkimSelector() + '._domainkey',
        type: 'TXT',
        expected: null,
        value: null,
        status: false
    };

    var dkimKey = readDkimPublicKeySync(domain);
    if (!dkimKey) return callback(new Error('Failed to read dkim public key'), dkim);

    dkim.expected = 'v=DKIM1; t=s; p=' + dkimKey;

    dns.resolve(dkim.domain, dkim.type, DNS_OPTIONS, function (error, txtRecords) {
        if (error) return callback(error, dkim);

        if (txtRecords.length !== 0) {
            dkim.value = txtRecords[0].join('');
            dkim.status = (dkim.value === dkim.expected);
        }

        callback(null, dkim);
    });
}

function checkSpf(domain, callback) {
    var spf = {
        domain: domain,
        name: '@',
        type: 'TXT',
        value: null,
        expected: 'v=spf1 a:' + config.mailFqdn() + ' ~all',
        status: false
    };

    dns.resolve(spf.domain, spf.type, DNS_OPTIONS, function (error, txtRecords) {
        if (error) return callback(error, spf);

        var i;
        for (i = 0; i < txtRecords.length; i++) {
            let txtRecord = txtRecords[i].join(''); // https://agari.zendesk.com/hc/en-us/articles/202952749-How-long-can-my-SPF-record-be-
            if (txtRecord.indexOf('v=spf1 ') !== 0) continue; // not SPF
            spf.value = txtRecord;
            spf.status = spf.value.indexOf(' a:' + config.adminFqdn()) !== -1;
            break;
        }

        if (spf.status) {
            spf.expected = spf.value;
        } else if (i !== txtRecords.length) {
            spf.expected = 'v=spf1 a:' + config.adminFqdn() + ' ' + spf.value.slice('v=spf1 '.length);
        }

        callback(null, spf);
    });
}

function checkMx(domain, callback) {
    var mx = {
        domain: domain,
        name: '@',
        type: 'MX',
        value: null,
        expected: '10 ' + config.mailFqdn() + '.',
        status: false
    };

    dns.resolve(mx.domain, mx.type, DNS_OPTIONS, function (error, mxRecords) {
        if (error) return callback(error, mx);

        if (mxRecords.length !== 0) {
            mx.status = mxRecords.length == 1 && mxRecords[0].exchange === config.mailFqdn();
            mx.value = mxRecords.map(function (r) { return r.priority + ' ' + r.exchange + '.'; }).join(' ');
        }

        callback(null, mx);
    });
}

function txtToDict(txt) {
    var dict = {};
    txt.split(';').forEach(function(v) {
        var p = v.trim().split('=');
        dict[p[0]]=p[1];
    });
    return dict;
}

function checkDmarc(domain, callback) {
    var dmarc = {
        domain: '_dmarc.' + domain,
        name: '_dmarc',
        type: 'TXT',
        value: null,
        expected: 'v=DMARC1; p=reject; pct=100',
        status: false
    };

    dns.resolve(dmarc.domain, dmarc.type, DNS_OPTIONS, function (error, txtRecords) {
        if (error) return callback(error, dmarc);

        if (txtRecords.length !== 0) {
            dmarc.value = txtRecords[0].join('');
            // allow extra fields in dmarc like rua
            const actual = txtToDict(dmarc.value), expected = txtToDict(dmarc.expected);
            dmarc.status = Object.keys(expected).every(k => expected[k] === actual[k]);
        }

        callback(null, dmarc);
    });
}

function checkPtr(callback) {
    var ptr = {
        domain: null,
        type: 'PTR',
        value: null,
        expected: config.mailFqdn(), // any trailing '.' is added by client software (https://lists.gt.net/spf/devel/7918)
        status: false
    };

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(error, ptr);

        ptr.domain = ip.split('.').reverse().join('.') + '.in-addr.arpa';

        dns.resolve(ptr.domain, 'PTR', DNS_OPTIONS, function (error, ptrRecords) {
            if (error) return callback(error, ptr);

            if (ptrRecords.length !== 0) {
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
        'name': 'Abuse.ch',
        'dns': 'spam.abuse.ch',
        'site': 'http://abuse.ch/'
    },

    {
        'name': 'Barracuda',
        'dns': 'b.barracudacentral.org',
        'site': 'http://www.barracudacentral.org/rbl/removal-request'
    },
    {
        'name': 'Composite Blocking List',
        'dns': 'cbl.abuseat.org',
        'site': 'http://www.abuseat.org'
    },
    {
        'name': 'Multi SURBL',
        'dns': 'multi.surbl.org',
        'site': 'http://www.surbl.org'
    },
    {
        'name': 'Passive Spam Block List',
        'dns': 'psbl.surriel.com',
        'site': 'https://psbl.org'
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
        'name': 'SpamCop',
        'dns': 'bl.spamcop.net',
        'site': 'http://spamcop.net'
    },
    {
        'name': 'SpamHaus Zen',
        'dns': 'zen.spamhaus.org',
        'site': 'http://spamhaus.org'
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

// this function currently only looks for black lists based on IP. TODO: also look up by domain
function checkRblStatus(domain, callback) {
    assert.strictEqual(typeof callback, 'function');

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(error, ip);

        var flippedIp = ip.split('.').reverse().join('.');

        // https://tools.ietf.org/html/rfc5782
        async.map(RBL_LIST, function (rblServer, iteratorDone) {
            dns.resolve(flippedIp + '.' + rblServer.dns, 'A', DNS_OPTIONS, function (error, records) {
                if (error || !records) return iteratorDone(null, null);    // not listed

                debug('checkRblStatus: %s (ip: %s) is in the blacklist of %j', domain, flippedIp, rblServer);

                var result = _.extend({ }, rblServer);

                dns.resolve(flippedIp + '.' + rblServer.dns, 'TXT', DNS_OPTIONS, function (error, txtRecords) {
                    result.txtRecords = error || !txtRecords ? 'No txt record' : txtRecords.map(x => x.join(''));

                    debug('checkRblStatus: %s (error: %s) (txtRecords: %j)', domain, error, txtRecords);

                    return iteratorDone(null, result);
                });
            });
        }, function (ignoredError, blacklistedServers) {
            blacklistedServers = blacklistedServers.filter(function(b) { return b !== null; });

            debug('checkRblStatus: %s (ip: %s) servers: %j', domain, ip, blacklistedServers);

            return callback(null, { status: blacklistedServers.length === 0, ip: ip, servers: blacklistedServers });
        });
    });
}

function getStatus(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    // ensure we always have a valid toplevel properties for the api
    var results = {
        dns: {},
        rbl: {},
        relay: {}
    };

    function recordResult(what, func) {
        return function (callback) {
            func(function (error, result) {
                if (error) debug('Ignored error - ' + what + ':', error);

                safe.set(results, what, result);

                callback();
            });
        };
    }

    getDomain(domain, function (error, result) {
        if (error) return callback(error);

        var checks = [
            recordResult('dns.mx', checkMx.bind(null, domain)),
            recordResult('dns.dmarc', checkDmarc.bind(null, domain))
        ];

        if (result.relay.provider === 'cloudron-smtp') {
            // these tests currently only make sense when using Cloudron's SMTP server at this point
            checks.push(
                recordResult('dns.spf', checkSpf.bind(null, domain)),
                recordResult('dns.dkim', checkDkim.bind(null, domain)),
                recordResult('dns.ptr', checkPtr),
                recordResult('relay', checkOutboundPort25),
                recordResult('rbl', checkRblStatus.bind(null, domain))
            );
        } else {
            checks.push(recordResult('relay', checkSmtpRelay.bind(null, result.relay)));
        }

        async.parallel(checks, function () {
            callback(null, results);
        });
    });
}

function createMailConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('createMailConfig: generating mail config');

    getDomains(function (error, mailDomains) {
        if (error) return callback(error);

        users.getOwner(function (error, owner) {
            const mailFqdn = config.mailFqdn();
            const defaultDomain = config.adminDomain();
            const alertsFrom = `no-reply@${defaultDomain}`;

            const alertsTo = config.provider() === 'caas' ? [ 'support@cloudron.io' ] : [ ];
            alertsTo.concat(error ? [] : owner.email).join(','); // owner may not exist yet

            const mailOutDomains = mailDomains.map(function (d) { return d.domain; }).join(',');
            const mailInDomains = mailDomains.filter(function (d) { return d.enabled; }).map(function (d) { return d.domain; }).join(',');

            if (!safe.fs.writeFileSync(path.join(paths.ADDON_CONFIG_DIR, 'mail/mail.ini'),
                `mail_in_domains=${mailInDomains}\nmail_out_domains=${mailOutDomains}\nmail_default_domain=${defaultDomain}\nmail_server_name=${mailFqdn}\nalerts_from=${alertsFrom}\nalerts_to=${alertsTo}\n\n`, 'utf8')) {
                return callback(new Error('Could not create mail var file:' + safe.error.message));
            }

            // enable_outbound makes plugin forward email for relayed mail. non-relayed mail always hits LMTP plugin first
            if (!safe.fs.writeFileSync(path.join(paths.ADDON_CONFIG_DIR, 'mail/smtp_forward.ini'), 'enable_outbound=false\ndomain_selector=mail_from\n', 'utf8')) {
                return callback(new Error('Could not create smtp forward file:' + safe.error.message));
            }

            // create sections for per-domain configuration
            mailDomains.forEach(function (domain) {
                const catchAll = domain.catchAll.map(function (c) { return `${c}@${domain.domain}`; }).join(',');
                const mailFromValidation = domain.mailFromValidation;

                if (!safe.fs.appendFileSync(path.join(paths.ADDON_CONFIG_DIR, 'mail/mail.ini'),
                    `[${domain.domain}]\ncatch_all=${catchAll}\nmail_from_validation=${mailFromValidation}\n\n`, 'utf8')) {
                    return callback(new Error('Could not create mail var file:' + safe.error.message));
                }

                const relay = domain.relay;

                const enableRelay = relay.provider !== 'cloudron-smtp',
                    host = relay.host || '',
                    port = relay.port || 25,
                    username = relay.username || '',
                    password = relay.password || '';

                if (!enableRelay) return;

                if (!safe.fs.appendFileSync(paths.ADDON_CONFIG_DIR + '/mail/smtp_forward.ini',
                    `[${domain.domain}]\nenable_outbound=true\nhost=${host}\nport=${port}\nenable_tls=true\nauth_type=plain\nauth_user=${username}\nauth_pass=${password}\n\n`, 'utf8')) {
                    return callback(new Error('Could not create mail var file:' + safe.error.message));
                }
            });

            callback(null, mailInDomains.length !== 0 /* allowInbound */);
        });
    });
}

function restartMail(callback) {
    // mail (note: 2525 is hardcoded in mail container and app use this port)
    // MAIL_SERVER_NAME is the hostname of the mailserver i.e server uses these certs
    // MAIL_DOMAIN is the domain for which this server is relaying mails
    // mail container uses /app/data for backed up data and /run for restart-able data

    if (process.env.BOX_ENV === 'test' && !process.env.TEST_CREATE_INFRA) return callback();

    const tag = infra.images.mail.tag;
    const memoryLimit = 4 * 256;

    // admin and mail share the same certificate
    reverseProxy.getCertificate({ fqdn: config.adminFqdn(), domain: config.adminDomain() }, function (error, bundle) {
        if (error) return callback(error);

        // the setup script copies dhparams.pem to /addons/mail
        const mailCertFilePath = path.join(paths.ADDON_CONFIG_DIR, 'mail/tls_cert.pem');
        const mailKeyFilePath = path.join(paths.ADDON_CONFIG_DIR, 'mail/tls_key.pem');

        if (!safe.child_process.execSync(`cp ${bundle.certFilePath} ${mailCertFilePath}`)) return callback(new Error('Could not create cert file:' + safe.error.message));
        if (!safe.child_process.execSync(`cp ${bundle.keyFilePath} ${mailKeyFilePath}`)) return callback(new Error('Could not create key file:' + safe.error.message));

        shell.execSync('startMail', 'docker rm -f mail || true');

        createMailConfig(function (error, allowInbound) {
            if (error) return callback(error);

            var ports = allowInbound ? '-p 587:2525 -p 993:9993 -p 4190:4190 -p 25:2525' : '';

            const cmd = `docker run --restart=always -d --name="mail" \
                        --net cloudron \
                        --net-alias mail \
                        --log-driver syslog \
                        --log-opt syslog-address=udp://127.0.0.1:2514 \
                        --log-opt syslog-format=rfc5424 \
                        --log-opt tag=mail \
                        -m ${memoryLimit}m \
                        --memory-swap ${memoryLimit * 2}m \
                        --dns 172.18.0.1 \
                        --dns-search=. \
                        -v "${paths.MAIL_DATA_DIR}:/app/data" \
                        -v "${paths.PLATFORM_DATA_DIR}/addons/mail:/etc/mail" \
                        ${ports} \
                        -p 127.0.0.1:2020:2020 \
                        --label isCloudronManaged=true \
                        --read-only -v /run -v /tmp ${tag}`;

            shell.execSync('startMail', cmd);

            callback();
        });
    });
}

function restartMailIfActivated(callback) {
    assert.strictEqual(typeof callback, 'function');

    users.isActivated(function (error, activated) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));
        if (!activated) {
            debug('restartMailIfActivated: skipping restart of mail container since Cloudron is not activated yet');
            return callback(); // not provisioned yet, do not restart container after dns setup
        }

        restartMail(callback);
    });
}

function getDomain(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    maildb.get(domain, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function getDomains(callback) {
    assert.strictEqual(typeof callback, 'function');

    maildb.getAll(function (error, results) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        return callback(null, results);
    });
}

// https://agari.zendesk.com/hc/en-us/articles/202952749-How-long-can-my-SPF-record-be-
function txtRecordsWithSpf(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    domains.getDnsRecords('', domain, 'TXT', function (error, txtRecords) {
        if (error) return new MailError(MailError.EXTERNAL_ERROR, error.message);

        debug('txtRecordsWithSpf: current txt records - %j', txtRecords);

        var i, matches, validSpf;

        for (i = 0; i < txtRecords.length; i++) {
            matches = txtRecords[i].match(/^("?v=spf1) /); // DO backend may return without quotes
            if (matches === null) continue;

            // this won't work if the entry is arbitrarily "split" across quoted strings
            validSpf = txtRecords[i].indexOf('a:' + config.mailFqdn()) !== -1;
            break; // there can only be one SPF record
        }

        if (validSpf) return callback(null, null);

        if (!matches) { // no spf record was found, create one
            txtRecords.push('"v=spf1 a:' + config.mailFqdn() + ' ~all"');
            debug('txtRecordsWithSpf: adding txt record');
        } else { // just add ourself
            txtRecords[i] = matches[1] + ' a:' + config.mailFqdn() + txtRecords[i].slice(matches[1].length);
            debug('txtRecordsWithSpf: inserting txt record');
        }

        return callback(null, txtRecords);
    });
}

function ensureDkimKeySync(domain) {
    assert.strictEqual(typeof domain, 'string');

    const dkimPath = path.join(paths.MAIL_DATA_DIR, `dkim/${domain}`);
    const dkimPrivateKeyFile = path.join(dkimPath, 'private');
    const dkimPublicKeyFile = path.join(dkimPath, 'public');
    const dkimSelectorFile = path.join(dkimPath, 'selector');

    if (safe.fs.existsSync(dkimPublicKeyFile) &&
        safe.fs.existsSync(dkimPublicKeyFile) &&
        safe.fs.existsSync(dkimPublicKeyFile)) {
        debug(`Reusing existing DKIM keys for ${domain}`);
        return null;
    }

    debug(`Generating new DKIM keys for ${domain}`);

    if (!safe.fs.mkdirSync(dkimPath) && safe.error.code !== 'EEXIST') {
        debug('Error creating dkim.', safe.error);
        return new MailError(MailError.INTERNAL_ERROR, safe.error);
    }

    if (!safe.child_process.execSync('openssl genrsa -out ' + dkimPrivateKeyFile + ' 1024')) return new MailError(MailError.INTERNAL_ERROR, safe.error);
    if (!safe.child_process.execSync('openssl rsa -in ' + dkimPrivateKeyFile + ' -out ' + dkimPublicKeyFile + ' -pubout -outform PEM')) return new MailError(MailError.INTERNAL_ERROR, safe.error);

    if (!safe.fs.writeFileSync(dkimSelectorFile, config.dkimSelector(), 'utf8')) return new MailError(MailError.INTERNAL_ERROR, safe.error);

    return null;
}

function readDkimPublicKeySync(domain) {
    assert.strictEqual(typeof domain, 'string');

    var dkimPath = path.join(paths.MAIL_DATA_DIR, `dkim/${domain}`);
    var dkimPublicKeyFile = path.join(dkimPath, 'public');

    var publicKey = safe.fs.readFileSync(dkimPublicKeyFile, 'utf8');

    if (publicKey === null) {
        debug('Error reading dkim public key.', safe.error);
        return null;
    }

    // remove header, footer and new lines
    publicKey = publicKey.split('\n').slice(1, -2).join('');

    return publicKey;
}

function setDnsRecords(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    maildb.get(domain, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        error = ensureDkimKeySync(domain);
        if (error) return callback(error);

        if (process.env.BOX_ENV === 'test') return callback();

        var dkimKey = readDkimPublicKeySync(domain);
        if (!dkimKey) return callback(new MailError(MailError.INTERNAL_ERROR, new Error('Failed to read dkim public key')));

        // t=s limits the domainkey to this domain and not it's subdomains
        var dkimRecord = { subdomain: config.dkimSelector() + '._domainkey', domain: domain, type: 'TXT', values: [ '"v=DKIM1; t=s; p=' + dkimKey + '"' ] };

        var records = [ ];
        records.push(dkimRecord);
        if (result.enabled) {
            records.push({ subdomain: '_dmarc', domain: domain, type: 'TXT', values: [ '"v=DMARC1; p=reject; pct=100"' ] });
            records.push({ subdomain: '', domain: domain, type: 'MX', values: [ '10 ' + config.mailFqdn() + '.' ] });
        }

        debug('setDnsRecords: %j', records);

        txtRecordsWithSpf(domain, function (error, txtRecords) {
            if (error) return callback(error);

            if (txtRecords) records.push({ subdomain: '', domain: domain, type: 'TXT', values: txtRecords });

            debug('setDnsRecords: will update %j', records);

            async.mapSeries(records, function (record, iteratorCallback) {
                domains.upsertDnsRecords(record.subdomain, record.domain, record.type, record.values, iteratorCallback);
            }, function (error, changeIds) {
                if (error) {
                    debug(`setDnsRecords: failed to update: ${error}`);
                    return callback(new MailError(MailError.EXTERNAL_ERROR, error.message));
                }

                debug('setDnsRecords: records %j added with changeIds %j', records, changeIds);

                callback(null);
            });
        });
    });
}

function addDomain(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    maildb.add(domain, function (error) {
        if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new MailError(MailError.ALREADY_EXISTS, 'Domain already exists'));
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'No such domain'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        async.series([
            setDnsRecords.bind(null, domain), // do this first to ensure DKIM keys
            restartMailIfActivated
        ], NOOP_CALLBACK); // do these asynchronously

        callback();
    });
}

function removeDomain(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (domain === config.adminDomain()) return callback(new MailError(MailError.IN_USE));

    maildb.del(domain, function (error) {
        if (error && error.reason === DatabaseError.IN_USE) return callback(new MailError(MailError.IN_USE));
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, error.message));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        restartMail(NOOP_CALLBACK);

        callback();
    });
}

function setMailFromValidation(domain, enabled, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof enabled, 'boolean');
    assert.strictEqual(typeof callback, 'function');

    maildb.update(domain, { mailFromValidation: enabled }, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        restartMail(NOOP_CALLBACK); // have to restart mail container since haraka cannot watch symlinked config files (mail.ini)

        callback(null);
    });
}

function setCatchAllAddress(domain, addresses, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert(Array.isArray(addresses));
    assert.strictEqual(typeof callback, 'function');

    maildb.update(domain, { catchAll: addresses }, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        restartMail(NOOP_CALLBACK); // have to restart mail container since haraka cannot watch symlinked config files (mail.ini)

        callback(null);
    });
}

function setMailRelay(domain, relay, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof relay, 'object');
    assert.strictEqual(typeof callback, 'function');

    verifyRelay(relay, function (error) {
        if (error) return callback(error);

        maildb.update(domain, { relay: relay }, function (error) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND));
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            restartMail(NOOP_CALLBACK);

            callback(null);
        });
    });
}

function setMailEnabled(domain, enabled, auditSource, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof enabled, 'boolean');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    maildb.update(domain, { enabled: enabled }, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        restartMail(NOOP_CALLBACK);

        eventlog.add(enabled ? eventlog.ACTION_MAIL_ENABLED : eventlog.ACTION_MAIL_DISABLED, auditSource, { domain });

        callback(null);
    });
}

function sendTestMail(domain, to, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof to, 'string');
    assert.strictEqual(typeof callback, 'function');

    getDomain(domain, function (error, result) {
        if (error) return callback(error);

        mailer.sendTestMail(result.domain, to);

        callback();
    });
}

function getMailboxes(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    mailboxdb.listMailboxes(domain, function (error, result) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null, result);
    });
}

function removeMailboxes(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    mailboxdb.delByDomain(domain, function (error) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback();
    });
}

function getMailbox(name, domain, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    mailboxdb.getMailbox(name, domain, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such mailbox'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null, result);
    });
}

function addMailbox(name, domain, userId, auditSource, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    name = name.toLowerCase();

    var error = validateName(name);
    if (error) return callback(error);

    mailboxdb.addMailbox(name, domain, userId, mailboxdb.OWNER_TYPE_USER, function (error) {
        if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new MailError(MailError.ALREADY_EXISTS, `mailbox ${name} already exists`));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        eventlog.add(eventlog.ACTION_MAIL_MAILBOX_ADD, auditSource, { name, domain, userId });

        callback(null);
    });
}

function updateMailbox(name, domain, userId, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    name = name.toLowerCase();

    var error = validateName(name);
    if (error) return callback(error);

    mailboxdb.updateMailbox(name, domain, userId, mailboxdb.OWNER_TYPE_USER, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such mailbox'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function removeMailbox(name, domain, auditSource, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    mailboxdb.del(name, domain, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such mailbox'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        eventlog.add(eventlog.ACTION_MAIL_MAILBOX_REMOVE, auditSource, { name, domain });

        callback(null);
    });
}

function listAliases(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    mailboxdb.listAliases(domain, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, error.message));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null, result);
    });
}

function getAliases(name, domain, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    getMailbox(name, domain, function (error) {
        if (error) return callback(error);

        mailboxdb.getAliasesForName(name, domain, function (error, aliases) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such mailbox'));
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            callback(null, aliases);
        });
    });
}

function setAliases(name, domain, aliases, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert(Array.isArray(aliases));
    assert.strictEqual(typeof callback, 'function');

    for (var i = 0; i < aliases.length; i++) {
        aliases[i] = aliases[i].toLowerCase();

        var error = validateName(aliases[i]);
        if (error) return callback(error);
    }

    mailboxdb.setAliasesForName(name, domain, aliases, function (error) {
        if (error && error.reason === DatabaseError.ALREADY_EXISTS && error.message.indexOf('mailboxes_name_domain_unique_index') !== -1) {
            var aliasMatch = error.message.match(new RegExp(`^ER_DUP_ENTRY: Duplicate entry '(.*)-${domain}' for key 'mailboxes_name_domain_unique_index'$`));
            if (!aliasMatch) return callback(new MailError(MailError.ALREADY_EXISTS, error.message));
            return callback(new MailError(MailError.ALREADY_EXISTS, `Mailbox, mailinglist or alias for ${aliasMatch[1]} already exists`));
        }
        if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new MailError(MailError.ALREADY_EXISTS, error.message));
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such mailbox'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function getLists(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    mailboxdb.listGroups(domain, function (error, result) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null, result);
    });
}

function getList(domain, listName, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof listName, 'string');
    assert.strictEqual(typeof callback, 'function');

    mailboxdb.getGroup(listName, domain, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such list'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null, result);
    });
}

function addList(name, domain, members, auditSource, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof name, 'string');
    assert(Array.isArray(members));
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    name = name.toLowerCase();

    var error = validateName(name);
    if (error) return callback(error);

    for (var i = 0; i < members.length; i++) {
        members[i] = members[i].toLowerCase();

        error = validateName(members[i]);
        if (error) return callback(error);
    }

    mailboxdb.addGroup(name, domain, members, function (error) {
        if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new MailError(MailError.ALREADY_EXISTS, 'list already exits'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        eventlog.add(eventlog.ACTION_MAIL_LIST_ADD, auditSource, { name, domain });

        callback();
    });
}

function updateList(name, domain, members, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert(Array.isArray(members));
    assert.strictEqual(typeof callback, 'function');

    name = name.toLowerCase();

    var error = validateName(name);
    if (error) return callback(error);

    for (var i = 0; i < members.length; i++) {
        members[i] = members[i].toLowerCase();

        error = validateName(members[i]);
        if (error) return callback(error);
    }

    mailboxdb.updateList(name, domain, members, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such mailbox'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function removeList(name, domain, auditSource, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    mailboxdb.del(name, domain, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such list'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        eventlog.add(eventlog.ACTION_MAIL_LIST_ADD, auditSource, { name, domain });

        callback();
    });
}
