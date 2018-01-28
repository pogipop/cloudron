'use strict';

exports = module.exports = {
    getStatus: getStatus,

    get: get,
    getAll: getAll,

    add: add,
    del: del,

    setMailFromValidation: setMailFromValidation,
    setCatchAllAddress: setCatchAllAddress,
    setMailRelay: setMailRelay,
    setMailEnabled: setMailEnabled,

    startMail: restartMail,

    sendTestMail: sendTestMail,

    getMailboxes: getMailboxes,
    getUserMailbox: getUserMailbox,
    enableUserMailbox: enableUserMailbox,
    disableUserMailbox: disableUserMailbox,

    getAliases: getAliases,
    setAliases: setAliases,

    getLists: getLists,
    getList: getList,
    addList: addList,
    removeList: removeList,

    _readDkimPublicKeySync: readDkimPublicKeySync,

    MailError: MailError
};

var assert = require('assert'),
    async = require('async'),
    certificates = require('./certificates.js'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:mail'),
    dig = require('./dig.js'),
    domains = require('./domains.js'),
    groups = require('./groups.js'),
    GroupError = groups.GroupError,
    infra = require('./infra_version.js'),
    mailboxdb = require('./mailboxdb.js'),
    maildb = require('./maildb.js'),
    mailer = require('./mailer.js'),
    net = require('net'),
    nodemailer = require('nodemailer'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    smtpTransport = require('nodemailer-smtp-transport'),
    sysinfo = require('./sysinfo.js'),
    user = require('./user.js'),
    UserError = user.UserError,
    util = require('util'),
    _ = require('underscore');

const digOptions = { server: '127.0.0.1', port: 53, timeout: 5000 };
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
MailError.BAD_FIELD = 'Bad Field';
MailError.ALREADY_EXISTS = 'Already Exists';
MailError.NOT_FOUND = 'Not Found';

function validateAlias(alias) {
    assert.strictEqual(typeof alias, 'string');

    if (alias.length < 1) return new MailError(MailError.BAD_FIELD, 'alias must be atleast 1 char');
    if (alias.length >= 200) return new MailError(MailError.BAD_FIELD, 'alias too long');

    if (constants.RESERVED_NAMES.indexOf(alias) !== -1) return new MailError(MailError.BAD_FIELD, 'alias is reserved');

    // +/- can be tricky in emails. also need to consider valid LDAP characters here (e.g '+' is reserved)
    if (/[^a-zA-Z0-9.]/.test(alias)) return new MailError(MailError.BAD_FIELD, 'alias can only contain alphanumerals and dot');

    // app emails are sent using the .app suffix
    if (alias.indexOf('.app') !== -1) return new MailError(MailError.BAD_FIELD, 'alias pattern is reserved for apps');

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

function checkDkim(domain, callback) {
    var dkim = {
        domain: config.dkimSelector() + '._domainkey.' + domain,
        type: 'TXT',
        expected: null,
        value: null,
        status: false
    };

    var dkimKey = readDkimPublicKeySync(domain);
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

function checkSpf(domain, callback) {
    var spf = {
        domain: domain,
        type: 'TXT',
        value: null,
        expected: '"v=spf1 a:' + config.mailFqdn() + ' ~all"',
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

function checkMx(domain, callback) {
    var mx = {
        domain: domain,
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

function checkDmarc(domain, callback) {
    var dmarc = {
        domain: '_dmarc.' + domain,
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

// this function currently only looks for black lists based on IP. TODO: also look up by domain
function checkRblStatus(domain, callback) {
    assert.strictEqual(typeof callback, 'function');

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(error, ip);

        var flippedIp = ip.split('.').reverse().join('.');

        // https://tools.ietf.org/html/rfc5782
        async.map(RBL_LIST, function (rblServer, iteratorDone) {
            dig.resolve(flippedIp + '.' + rblServer.dns, 'A', digOptions, function (error, records) {
                if (error || !records) return iteratorDone(null, null);    // not listed

                debug('checkRblStatus: %s (ip: %s) is in the blacklist of %j', domain, flippedIp, rblServer);

                var result = _.extend({ }, rblServer);

                dig.resolve(flippedIp + '.' + rblServer.dns, 'TXT', digOptions, function (error, txtRecords) {
                    result.txtRecords = error || !txtRecords ? 'No txt record' : txtRecords;

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

    get(domain, function (error, result) {
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

    const mailFqdn = config.mailFqdn();

    debug('createMailConfig: generating mail config');

    maildb.getAll(function (error, mailOutDomains) {
        if (error) return callback(error);

        var mailDomain = mailOutDomains[0]; // mail container can only handle one domain at this point

        const alertsFrom = `no-reply@${mailDomain.domain}`;

        user.getOwner(function (error, owner) {
            const alertsTo = config.provider() === 'caas' ? [ 'support@cloudron.io' ] : [ ];
            alertsTo.concat(error ? [] : owner.email).join(','); // owner may not exist yet

            const mailOutDomain = mailDomain.domain;
            const mailInDomain = mailDomain.enabled ? mailDomain.domain : '';
            const catchAll = mailDomain.catchAll.map(function (c) { return `${c}@${mailDomain.domain}`; }).join(',');
            const mailFromValidation = mailDomain.mailFromValidation;

            if (!safe.fs.writeFileSync(paths.ADDON_CONFIG_DIR + '/mail/mail.ini',
                `mail_in_domains=${mailInDomain}\nmail_out_domains=${mailOutDomain}\nmail_default_domain=${mailDomain.domain}\nmail_server_name=${mailFqdn}\nalerts_from=${alertsFrom}\nalerts_to=${alertsTo}\ncatch_all=${catchAll}\nmail_from_validation=${mailFromValidation}\n`, 'utf8')) {
                return callback(new Error('Could not create mail var file:' + safe.error.message));
            }

            var relay = mailDomain.relay;

            const enabled = relay.provider !== 'cloudron-smtp' ? true : false,
                host = relay.host || '',
                port = relay.port || 25,
                username = relay.username || '',
                password = relay.password || '';

            if (!safe.fs.writeFileSync(paths.ADDON_CONFIG_DIR + '/mail/smtp_forward.ini',
                `enable_outbound=${enabled}\nhost=${host}\nport=${port}\nenable_tls=true\nauth_type=plain\nauth_user=${username}\nauth_pass=${password}`, 'utf8')) {
                return callback(new Error('Could not create mail var file:' + safe.error.message));
            }

            callback(null, mailInDomain.length !== 0);
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
    const memoryLimit = Math.max((1 + Math.round(os.totalmem()/(1024*1024*1024)/4)) * 128, 256);

    // admin and mail share the same certificate
    certificates.getAdminCertificate(function (error, cert, key) {
        if (error) return callback(error);

        // the setup script copies dhparams.pem to /addons/mail
        if (!safe.fs.writeFileSync(paths.ADDON_CONFIG_DIR + '/mail/tls_cert.pem', cert)) return callback(new Error('Could not create cert file:' + safe.error.message));
        if (!safe.fs.writeFileSync(paths.ADDON_CONFIG_DIR + '/mail/tls_key.pem', key))  return callback(new Error('Could not create key file:' + safe.error.message));

        shell.execSync('startMail', 'docker rm -f mail || true');

        createMailConfig(function (error, allowInbound) {
            if (error) return callback(error);

            var ports = allowInbound ? '-p 587:2525 -p 993:9993 -p 4190:4190 -p 25:2525' : '';

            const cmd = `docker run --restart=always -d --name="mail" \
                        --net cloudron \
                        --net-alias mail \
                        -m ${memoryLimit}m \
                        --memory-swap ${memoryLimit * 2}m \
                        --dns 172.18.0.1 \
                        --dns-search=. \
                        -v "${paths.MAIL_DATA_DIR}:/app/data" \
                        -v "${paths.PLATFORM_DATA_DIR}/addons/mail:/etc/mail" \
                        ${ports} \
                        --read-only -v /run -v /tmp ${tag}`;

            shell.execSync('startMail', cmd);

            callback();
        });
    });
}

function get(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    maildb.get(domain, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    maildb.getAll(function (error, results) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        return callback(null, results);
    });
}

function ensureDkimKey(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    var dkimPath = path.join(paths.MAIL_DATA_DIR, `dkim/${domain}`);
    var dkimPrivateKeyFile = path.join(dkimPath, 'private');
    var dkimPublicKeyFile = path.join(dkimPath, 'public');
    var dkimSelectorFile = path.join(dkimPath, 'selector');

    debug('Generating new DKIM keys');

    if (!safe.fs.mkdirSync(dkimPath) && safe.error.code !== 'EEXIST') {
        debug('Error creating dkim.', safe.error);
        return new MailError(MailError.INTERNAL_ERROR, safe.error);
    }

    if (!safe.child_process.execSync('openssl genrsa -out ' + dkimPrivateKeyFile + ' 1024')) return new MailError(MailError.INTERNAL_ERROR, safe.error);
    if (!safe.child_process.execSync('openssl rsa -in ' + dkimPrivateKeyFile + ' -out ' + dkimPublicKeyFile + ' -pubout -outform PEM')) return new MailError(MailError.INTERNAL_ERROR, safe.error);

    if (!safe.fs.writeFileSync(dkimSelectorFile, config.dkimSelector(), 'utf8')) return new MailError(MailError.INTERNAL_ERROR, safe.error);

    callback();
}

// https://agari.zendesk.com/hc/en-us/articles/202952749-How-long-can-my-SPF-record-be-
function txtRecordsWithSpf(callback) {
    assert.strictEqual(typeof callback, 'function');

    domains.getDNSRecords('', config.adminDomain(), 'TXT', function (error, txtRecords) {
        if (error) return callback(error);

        debug('txtRecordsWithSpf: current txt records - %j', txtRecords);

        var i, matches, validSpf;

        for (i = 0; i < txtRecords.length; i++) {
            matches = txtRecords[i].match(/^("?v=spf1) /); // DO backend may return without quotes
            if (matches === null) continue;

            // this won't work if the entry is arbitrarily "split" across quoted strings
            validSpf = txtRecords[i].indexOf('a:' + config.adminFqdn()) !== -1;
            break; // there can only be one SPF record
        }

        if (validSpf) return callback(null, null);

        if (!matches) { // no spf record was found, create one
            txtRecords.push('"v=spf1 a:' + config.adminFqdn() + ' ~all"');
            debug('txtRecordsWithSpf: adding txt record');
        } else { // just add ourself
            txtRecords[i] = matches[1] + ' a:' + config.adminFqdn() + txtRecords[i].slice(matches[1].length);
            debug('txtRecordsWithSpf: inserting txt record');
        }

        return callback(null, txtRecords);
    });
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

function addDnsRecords(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (process.env.BOX_ENV === 'test') return callback();

    var dkimKey = readDkimPublicKeySync(domain);
    if (!dkimKey) return callback(new MailError(MailError.INTERNAL_ERROR, new Error('Failed to read dkim public key')));

    // t=s limits the domainkey to this domain and not it's subdomains
    var dkimRecord = { subdomain: config.dkimSelector() + '._domainkey', domain: domain, type: 'TXT', values: [ '"v=DKIM1; t=s; p=' + dkimKey + '"' ] };

    var records = [ ];
    records.push(dkimRecord);

    debug('addDnsRecords: %j', records);

    async.retry({ times: 10, interval: 20000 }, function (retryCallback) {
        txtRecordsWithSpf(function (error, txtRecords) {
            if (error) return retryCallback(error);

            if (txtRecords) records.push({ subdomain: '', domain: domain, type: 'TXT', values: txtRecords });

            debug('addDnsRecords: will update %j', records);

            async.mapSeries(records, function (record, iteratorCallback) {
                domains.upsertDNSRecords(record.subdomain, record.domain, record.type, record.values, iteratorCallback);
            }, function (error, changeIds) {
                if (error) debug('addDnsRecords: failed to update : %s. will retry', error);
                else debug('addDnsRecords: records %j added with changeIds %j', records, changeIds);

                retryCallback(error);
            });
        });
    }, function (error) {
        if (error) debug('addDnsRecords: done updating records with error:', error);
        else debug('addDnsRecords: done');

        callback(error);
    });
}

function add(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    ensureDkimKey(domain, function (error) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        maildb.add(domain, function (error) {
            if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new MailError(MailError.ALREADY_EXISTS, 'Domain already exists'));
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'No such domain'));
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            addDnsRecords(domain, NOOP_CALLBACK); // add the required dns records asynchronously

            callback();
        });
    });
}

function del(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    maildb.del(domain, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, error.message));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

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

        createMailConfig(NOOP_CALLBACK);

        callback(null);
    });
}

function setCatchAllAddress(domain, address, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert(Array.isArray(address));
    assert.strictEqual(typeof callback, 'function');

    maildb.update(domain, { catchAll: address }, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        createMailConfig(NOOP_CALLBACK);

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
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            restartMail(NOOP_CALLBACK);

            callback(null);
        });
    });
}

function setMailEnabled(domain, enabled, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof enabled, 'boolean');
    assert.strictEqual(typeof callback, 'function');

    maildb.update(domain, { enabled: enabled }, function (error) {
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        restartMail(NOOP_CALLBACK);

        if (!enabled || process.env.BOX_ENV === 'test') return callback(null);

        // Add MX and DMARC record. Note that DMARC policy depends on DKIM signing and thus works
        // only if we use our internal mail server.
        var records = [
            { subdomain: '_dmarc', type: 'TXT', values: [ '"v=DMARC1; p=reject; pct=100"' ] },
            { subdomain: '', type: 'MX', values: [ '10 ' + config.mailFqdn() + '.' ] }
        ];

        async.mapSeries(records, function (record, iteratorCallback) {
            domains.upsertDNSRecords(record.subdomain, domain, record.type, record.values, iteratorCallback);
        }, NOOP_CALLBACK);

        callback(null);
    });
}

function sendTestMail(domain, to, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof to, 'object');
    assert.strictEqual(typeof callback, 'function');

    get(domain, function (error, result) {
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

function getUserMailbox(domain, userId, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    user.get(userId, function (error, result) {
        if (error && error.reason === UserError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such user'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        mailboxdb.getMailbox(result.username, domain, function (error, result) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such mailbox'));
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            callback(null, result);
        });
    });
}

function enableUserMailbox(domain, userId, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    user.get(userId, function (error, result) {
        if (error && error.reason === UserError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such user'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR));

        mailboxdb.add(result.username, domain, userId, mailboxdb.TYPE_USER, function (error) {
            if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new MailError(MailError.ALREADY_EXISTS, 'mailbox already exists'));
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            callback(null);
        });
    });
}

function disableUserMailbox(domain, userId, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    user.get(userId, function (error, result) {
        if (error && error.reason === UserError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such user'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        mailboxdb.del(result.username, domain, function (error) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such mailbox'));
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            callback(null);
        });
    });
}

function getAliases(domain, userId, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    user.get(userId, function (error, result) {
        if (error && error.reason === UserError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such user'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        if (!result.username) return callback(null, []);

        mailboxdb.getAliasesForName(result.username, domain, function (error, aliases) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such mailbox'));
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            callback(null, aliases);
        });
    });
}

function setAliases(domain, userId, aliases, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert(Array.isArray(aliases));
    assert.strictEqual(typeof callback, 'function');

    for (var i = 0; i < aliases.length; i++) {
        aliases[i] = aliases[i].toLowerCase();

        var error = validateAlias(aliases[i]);
        if (error) return callback(error);
    }

    user.get(userId, function (error, result) {
        if (error && error.reason === UserError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such user'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        mailboxdb.setAliasesForName(result.username, domain, aliases, function (error) {
            if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new MailError(MailError.ALREADY_EXISTS, error.message));
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such mailbox'));
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            callback(null);
        });
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

function getList(domain, groupId, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof groupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    groups.get(groupId, function (error, result) {
        if (error && error.reason === GroupError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such group'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        mailboxdb.getGroup(result.name, domain, function (error, result) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such list'));
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            callback(null, result);
        });
    });
}

function addList(domain, groupId, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof groupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    groups.get(groupId, function (error, result) {
        if (error && error.reason === GroupError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such group'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        mailboxdb.add(result.name, domain, groupId, mailboxdb.TYPE_GROUP, function (error) {
            if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new MailError(MailError.ALREADY_EXISTS, 'list already exits'));
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            callback();
        });
    });
}

function removeList(domain, groupId, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof groupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    groups.get(groupId, function (error, result) {
        if (error && error.reason === GroupError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such group'));
        if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

        mailboxdb.del(result.name, domain, function (error) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new MailError(MailError.NOT_FOUND, 'no such list'));
            if (error) return callback(new MailError(MailError.INTERNAL_ERROR, error));

            callback();
        });
    });
}
