'use strict';

exports = module.exports = {
    userAdded: userAdded,
    userRemoved: userRemoved,
    adminChanged: adminChanged,
    passwordReset: passwordReset,
    boxUpdateAvailable: boxUpdateAvailable,
    appUpdateAvailable: appUpdateAvailable,
    sendDigest: sendDigest,

    sendInvite: sendInvite,
    unexpectedExit: unexpectedExit,

    appDied: appDied,
    oomEvent: oomEvent,

    outOfDiskSpace: outOfDiskSpace,
    backupFailed: backupFailed,

    certificateRenewalError: certificateRenewalError,

    sendTestMail: sendTestMail,

    _getMailQueue: _getMailQueue,
    _clearMailQueue: _clearMailQueue
};

var assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
    debug = require('debug')('box:mailer'),
    docker = require('./docker.js').connection,
    ejs = require('ejs'),
    mail = require('./mail.js'),
    nodemailer = require('nodemailer'),
    path = require('path'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    showdown = require('showdown'),
    smtpTransport = require('nodemailer-smtp-transport'),
    users = require('./users.js'),
    util = require('util'),
    _ = require('underscore');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

var MAIL_TEMPLATES_DIR = path.join(__dirname, 'mail_templates');

var gMailQueue = [ ];

function splatchError(error) {
    var result = { };
    Object.getOwnPropertyNames(error).forEach(function (key) {
        var value = this[key];
        if (value instanceof Error) value = splatchError(value);
        result[key] = value;
    }, error /* thisArg */);

    return util.inspect(result, { depth: null, showHidden: true });
}

function getAdminEmails(callback) {
    users.getAllAdmins(function (error, admins) {
        if (error) return callback(error);

        if (admins.length === 0) return callback(new Error('No admins on this cloudron')); // box not activated yet

        var adminEmails = [ ];
        admins.forEach(function (admin) { adminEmails.push(admin.email); });

        callback(null, adminEmails);
    });
}

// This will collect the most common details required for notification emails
function getMailConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    getAdminEmails(function (error, adminEmails) {
        if (error) return callback(error);

        settings.getCloudronName(function (error, cloudronName) {
            // this is not fatal
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

            mail.getDomains(function (error, domains) {
                if (error) return callback(error);
                if (domains.length === 0) return callback('No domains configured');

                const defaultDomain = domains[0];

                callback(null, {
                    adminEmails: adminEmails,
                    cloudronName: cloudronName,
                    notificationDomain: defaultDomain.domain,
                    notificationFrom: `"${cloudronName}" <no-reply@${defaultDomain.domain}>`
                });
            });
        });
    });
}


function processQueue() {
    sendMails(gMailQueue);
    gMailQueue = [ ];
}

// note : this function should NOT access the database. it is called by the crashnotifier
// which does not initialize mailer or the databse
function sendMails(queue, callback) {
    assert(util.isArray(queue));
    callback = callback || NOOP_CALLBACK;

    docker.getContainer('mail').inspect(function (error, data) {
        if (error) return callback(error);

        var mailServerIp = safe.query(data, 'NetworkSettings.Networks.cloudron.IPAddress');
        if (!mailServerIp) return callback('Error querying mail server IP');

        var transport = nodemailer.createTransport(smtpTransport({
            host: mailServerIp,
            port: config.get('smtpPort')
        }));

        debug('Processing mail queue of size %d (through %s:2525)', queue.length, mailServerIp);

        async.mapSeries(queue, function iterator(mailOptions, callback) {
            transport.sendMail(mailOptions, function (error) {
                if (error) return debug(error); // TODO: requeue?
                debug('Email sent to ' + mailOptions.to);
            });
            callback(null);
        }, function done() {
            debug('Done processing mail queue');

            callback(null);
        });
    });
}

function enqueue(mailOptions) {
    assert.strictEqual(typeof mailOptions, 'object');

    if (!mailOptions.from) debug('sender address is missing');
    if (!mailOptions.to) debug('recipient address is missing');

    debug('Queued mail for ' + mailOptions.from + ' to ' + mailOptions.to);
    gMailQueue.push(mailOptions);

    if (process.env.BOX_ENV !== 'test') processQueue();
}

function render(templateFile, params) {
    assert.strictEqual(typeof templateFile, 'string');
    assert.strictEqual(typeof params, 'object');

    var content = null;

    try {
        content = ejs.render(safe.fs.readFileSync(path.join(MAIL_TEMPLATES_DIR, templateFile), 'utf8'), params);
    } catch (e) {
        debug(`Error rendering ${templateFile}`, e);
    }

    return content;
}

function mailUserEventToAdmins(user, event) {
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof event, 'string');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var adminEmails = _.difference(mailConfig.adminEmails, [ user.email ]);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: adminEmails.join(', '),
            subject: util.format('[%s] %s %s', mailConfig.cloudronName, user.username || user.fallbackEmail || user.email, event),
            text: render('user_event.ejs', { user: user, event: event, format: 'text' }),
        };

        enqueue(mailOptions);
    });
}

function sendInvite(user, invitor) {
    assert.strictEqual(typeof user, 'object');
    assert(typeof invitor === 'object');

    debug('Sending invite mail');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var templateData = {
            user: user,
            webadminUrl: config.adminOrigin(),
            setupLink: `${config.adminOrigin()}/api/v1/session/account/setup.html?reset_token=${user.resetToken}&email=${encodeURIComponent(user.email)}`,
            invitor: invitor,
            cloudronName: mailConfig.cloudronName,
            cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar'
        };

        var templateDataText = JSON.parse(JSON.stringify(templateData));
        templateDataText.format = 'text';

        var templateDataHTML = JSON.parse(JSON.stringify(templateData));
        templateDataHTML.format = 'html';

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: user.fallbackEmail,
            subject: util.format('Welcome to %s', mailConfig.cloudronName),
            text: render('welcome_user.ejs', templateDataText),
            html: render('welcome_user.ejs', templateDataHTML)
        };

        enqueue(mailOptions);
    });
}

function userAdded(user) {
    assert.strictEqual(typeof user, 'object');

    debug('Sending mail for userAdded');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var adminEmails = _.difference(mailConfig.adminEmails, [ user.email ]);

        var templateData = {
            user: user,
            cloudronName: mailConfig.cloudronName,
            cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar'
        };

        var templateDataText = JSON.parse(JSON.stringify(templateData));
        templateDataText.format = 'text';

        var templateDataHTML = JSON.parse(JSON.stringify(templateData));
        templateDataHTML.format = 'html';

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: adminEmails.join(', '),
            subject: util.format('[%s] User %s added', mailConfig.cloudronName, user.fallbackEmail),
            text: render('user_added.ejs', templateDataText),
            html: render('user_added.ejs', templateDataHTML)
        };

        enqueue(mailOptions);
    });
}

function userRemoved(user) {
    assert.strictEqual(typeof user, 'object');

    debug('Sending mail for userRemoved.', user.id, user.email);

    mailUserEventToAdmins(user, 'was removed');
}

function adminChanged(user, admin) {
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof admin, 'boolean');

    debug('Sending mail for adminChanged');

    mailUserEventToAdmins(user, admin ? 'is now an admin' : 'is no more an admin');
}

function passwordReset(user) {
    assert.strictEqual(typeof user, 'object');

    debug('Sending mail for password reset for user %s.', user.email, user.id);

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var templateData = {
            user: user,
            resetLink: `${config.adminOrigin()}/api/v1/session/password/reset.html?reset_token=${user.resetToken}&email=${encodeURIComponent(user.email)}`,
            cloudronName: mailConfig.cloudronName,
            cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar'
        };

        var templateDataText = JSON.parse(JSON.stringify(templateData));
        templateDataText.format = 'text';

        var templateDataHTML = JSON.parse(JSON.stringify(templateData));
        templateDataHTML.format = 'html';

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: user.fallbackEmail,
            subject: util.format('[%s] Password Reset', mailConfig.cloudronName),
            text: render('password_reset.ejs', templateDataText),
            html: render('password_reset.ejs', templateDataHTML)
        };

        enqueue(mailOptions);
    });
}

function appDied(app) {
    assert.strictEqual(typeof app, 'object');

    debug('Sending mail for app %s @ %s died', app.id, app.fqdn);

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: config.provider() === 'caas' ? 'support@cloudron.io' : mailConfig.adminEmails.join(', '),
            subject: util.format('[%s] App %s is down', mailConfig.cloudronName, app.fqdn),
            text: render('app_down.ejs', { title: app.manifest.title, appFqdn: app.fqdn, format: 'text' })
        };

        enqueue(mailOptions);
    });
}

function boxUpdateAvailable(hasSubscription, newBoxVersion, changelog) {
    assert.strictEqual(typeof hasSubscription, 'boolean');
    assert.strictEqual(typeof newBoxVersion, 'string');
    assert(util.isArray(changelog));

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var converter = new showdown.Converter();

        var templateData = {
            webadminUrl: config.adminOrigin(),
            newBoxVersion: newBoxVersion,
            hasSubscription: hasSubscription,
            changelog: changelog,
            changelogHTML: changelog.map(function (e) { return converter.makeHtml(e); }),
            cloudronName: mailConfig.cloudronName,
            cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar'
        };

        var templateDataText = JSON.parse(JSON.stringify(templateData));
        templateDataText.format = 'text';

        var templateDataHTML = JSON.parse(JSON.stringify(templateData));
        templateDataHTML.format = 'html';

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: mailConfig.adminEmails.join(', '),
            subject: util.format('%s has a new update available', mailConfig.cloudronName),
            text: render('box_update_available.ejs', templateDataText),
            html: render('box_update_available.ejs', templateDataHTML)
        };

        enqueue(mailOptions);
    });
}

function appUpdateAvailable(app, hasSubscription, info) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof hasSubscription, 'boolean');
    assert.strictEqual(typeof info, 'object');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var converter = new showdown.Converter();

        var templateData = {
            webadminUrl: config.adminOrigin(),
            hasSubscription: hasSubscription,
            app: app,
            updateInfo: info,
            changelogHTML: converter.makeHtml(info.manifest.changelog),
            cloudronName: mailConfig.cloudronName,
            cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar'
        };

        var templateDataText = JSON.parse(JSON.stringify(templateData));
        templateDataText.format = 'text';

        var templateDataHTML = JSON.parse(JSON.stringify(templateData));
        templateDataHTML.format = 'html';

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: mailConfig.adminEmails.join(', '),
            subject: util.format('App %s has a new update available', app.fqdn),
            text: render('app_update_available.ejs', templateDataText),
            html: render('app_update_available.ejs', templateDataHTML)
        };

        enqueue(mailOptions);
    });
}

function sendDigest(info) {
    assert.strictEqual(typeof info, 'object');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var templateData = {
            webadminUrl: config.adminOrigin(),
            cloudronName: mailConfig.cloudronName,
            cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar',
            info: info
        };

        var templateDataText = JSON.parse(JSON.stringify(templateData));
        templateDataText.format = 'text';

        var templateDataHTML = JSON.parse(JSON.stringify(templateData));
        templateDataHTML.format = 'html';

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: mailConfig.adminEmails.join(', '),
            subject: util.format('[%s] Weekly activity digest', mailConfig.cloudronName),
            text: render('digest.ejs', templateDataText),
            html: render('digest.ejs', templateDataHTML)
        };

        enqueue(mailOptions);
    });
}

function outOfDiskSpace(message) {
    assert.strictEqual(typeof message, 'string');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: config.provider() === 'caas' ? 'support@cloudron.io' : mailConfig.adminEmails.join(', '),
            subject: util.format('[%s] Out of disk space alert', mailConfig.cloudronName),
            text: render('out_of_disk_space.ejs', { cloudronName: mailConfig.cloudronName, message: message, format: 'text' })
        };

        sendMails([ mailOptions ]);
    });
}

function backupFailed(error) {
    var message = splatchError(error);

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: config.provider() === 'caas' ? 'support@cloudron.io' : mailConfig.adminEmails.join(', '),
            subject: util.format('[%s] Failed to backup', mailConfig.cloudronName),
            text: render('backup_failed.ejs', { cloudronName: mailConfig.cloudronName, message: message, format: 'text' })
        };

        enqueue(mailOptions);
    });
}

function certificateRenewalError(domain, message) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof message, 'string');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: config.provider() === 'caas' ? 'support@cloudron.io' : mailConfig.adminEmails.join(', '),
            subject: util.format('[%s] Certificate renewal error', domain),
            text: render('certificate_renewal_error.ejs', { domain: domain, message: message, format: 'text' })
        };

        sendMails([ mailOptions ]);
    });
}

function oomEvent(program, context) {
    assert.strictEqual(typeof program, 'string');
    assert.strictEqual(typeof context, 'string');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: config.provider() === 'caas' ? 'support@cloudron.io' : mailConfig.adminEmails.join(', '),
            subject: util.format('[%s] %s exited unexpectedly', mailConfig.cloudronName, program),
            text: render('oom_event.ejs', { cloudronName: mailConfig.cloudronName, program: program, context: context, format: 'text' })
        };

        sendMails([ mailOptions ]);
    });
}

// this function bypasses the queue intentionally. it is also expected to work without the mailer module initialized
// NOTE: crashnotifier should ideally be able to send mail when there is no db, however we need the 'from' address domain from the db
function unexpectedExit(program, context, callback) {
    assert.strictEqual(typeof program, 'string');
    assert.strictEqual(typeof context, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (config.provider() !== 'caas') return callback(); // no way to get admins without db access

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: 'support@cloudron.io',
            subject: util.format('[%s] %s exited unexpectedly', mailConfig.cloudronName, program),
            text: render('unexpected_exit.ejs', { cloudronName: mailConfig.cloudronName, program: program, context: context, format: 'text' })
        };

        sendMails([ mailOptions ], callback);
    });
}

function sendTestMail(domain, email) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof email, 'string');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: `"${mailConfig.cloudronName}" <no-reply@${domain}>`,
            to: email,
            subject: util.format('Test Email from %s', mailConfig.cloudronName),
            text: render('test.ejs', { cloudronName: mailConfig.cloudronName, format: 'text'})
        };

        enqueue(mailOptions);
    });
}

function _getMailQueue() {
    return gMailQueue;
}

function _clearMailQueue(callback) {
    gMailQueue = [];

    if (callback) callback();
}
