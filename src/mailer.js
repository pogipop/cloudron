'use strict';

exports = module.exports = {
    start: start,
    stop: stop,

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

    FEEDBACK_TYPE_FEEDBACK: 'feedback',
    FEEDBACK_TYPE_TICKET: 'ticket',
    FEEDBACK_TYPE_APP_MISSING: 'app_missing',
    FEEDBACK_TYPE_APP_ERROR: 'app_error',
    FEEDBACK_TYPE_UPGRADE_REQUEST: 'upgrade_request',
    sendFeedback: sendFeedback,

    _getMailQueue: _getMailQueue,
    _clearMailQueue: _clearMailQueue
};

var assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
    debug = require('debug')('box:mailer'),
    docker = require('./docker.js').connection,
    ejs = require('ejs'),
    nodemailer = require('nodemailer'),
    path = require('path'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    showdown = require('showdown'),
    smtpTransport = require('nodemailer-smtp-transport'),
    users = require('./user.js'),
    util = require('util'),
    _ = require('underscore');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

var MAIL_TEMPLATES_DIR = path.join(__dirname, 'mail_templates');

var gMailQueue = [ ],
    gPaused = false;

function splatchError(error) {
    var result = { };
    Object.getOwnPropertyNames(error).forEach(function (key) {
        var value = this[key];
        if (value instanceof Error) value = splatchError(value);
        result[key] = value;
    }, error /* thisArg */);

    return util.inspect(result, { depth: null, showHidden: true });
}

function start(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (process.env.BOX_ENV === 'test') gPaused = true;

    callback(null);
}

function stop(callback) {
    assert.strictEqual(typeof callback, 'function');

    // TODO: interrupt processQueue as well

    debug(gMailQueue.length + ' mail items dropped');
    gMailQueue = [ ];

    callback(null);
}

function mailConfig() {
    return {
        from: '"Cloudron" <no-reply@' + config.fqdn() + '>'
    };
}

function processQueue() {
    assert(!gPaused);

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

    if (!gPaused) processQueue();
}

function render(templateFile, params) {
    assert.strictEqual(typeof templateFile, 'string');
    assert.strictEqual(typeof params, 'object');

    return ejs.render(safe.fs.readFileSync(path.join(MAIL_TEMPLATES_DIR, templateFile), 'utf8'), params);
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

function mailUserEventToAdmins(user, event) {
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof event, 'string');

    getAdminEmails(function (error, adminEmails) {
        if (error) return debug('Error getting admins', error);

        adminEmails = _.difference(adminEmails, [ user.email ]);

        var mailOptions = {
            from: mailConfig().from,
            to: adminEmails.join(', '),
            subject: util.format('[%s] %s %s', config.fqdn(), user.username || user.alternateEmail || user.email, event),
            text: render('user_event.ejs', { fqdn: config.fqdn(), user: user, event: event, format: 'text' }),
        };

        enqueue(mailOptions);
    });
}

function sendInvite(user, invitor) {
    assert.strictEqual(typeof user, 'object');
    assert(typeof invitor === 'object');

    debug('Sending invite mail');

    settings.getCloudronName(function (error, cloudronName) {
        if (error) {
            debug(error);
            cloudronName = 'Cloudron';
        }

        var templateData = {
            user: user,
            webadminUrl: config.adminOrigin(),
            setupLink: config.adminOrigin() + '/api/v1/session/account/setup.html?reset_token=' + user.resetToken,
            fqdn: config.fqdn(),
            invitor: invitor,
            cloudronName: cloudronName,
            cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar'
        };

        var templateDataText = JSON.parse(JSON.stringify(templateData));
        templateDataText.format = 'text';

        var templateDataHTML = JSON.parse(JSON.stringify(templateData));
        templateDataHTML.format = 'html';

        var mailOptions = {
            from: mailConfig().from,
            to: user.alternateEmail || user.email,
            subject: util.format('Welcome to %s', cloudronName),
            text: render('welcome_user.ejs', templateDataText),
            html: render('welcome_user.ejs', templateDataHTML)
        };

        enqueue(mailOptions);
    });
}

function userAdded(user, inviteSent) {
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof inviteSent, 'boolean');

    debug('Sending mail for userAdded %s including invite link', inviteSent ? 'not' : '');

    getAdminEmails(function (error, adminEmails) {
        if (error) return console.log('Error getting admins', error);

        adminEmails = _.difference(adminEmails, [ user.email ]);

        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

            var templateData = {
                fqdn: config.fqdn(),
                user: user,
                inviteLink: inviteSent ? null : config.adminOrigin() + '/api/v1/session/account/setup.html?reset_token=' + user.resetToken,
                cloudronName: cloudronName,
                cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar'
            };

            var templateDataText = JSON.parse(JSON.stringify(templateData));
            templateDataText.format = 'text';

            var templateDataHTML = JSON.parse(JSON.stringify(templateData));
            templateDataHTML.format = 'html';

            var mailOptions = {
                from: mailConfig().from,
                to: adminEmails.join(', '),
                subject: util.format('[%s] User %s added', config.fqdn(), user.alternateEmail || user.email),
                text: render('user_added.ejs', templateDataText),
                html: render('user_added.ejs', templateDataHTML)
            };

            enqueue(mailOptions);
        });
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

    settings.getCloudronName(function (error, cloudronName) {
        if (error) {
            debug(error);
            cloudronName = 'Cloudron';
        }

        var templateData = {
            fqdn: config.fqdn(),
            user: user,
            resetLink: config.adminOrigin() + '/api/v1/session/password/reset.html?reset_token=' + user.resetToken,
            cloudronName: cloudronName,
            cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar'
        };

        var templateDataText = JSON.parse(JSON.stringify(templateData));
        templateDataText.format = 'text';

        var templateDataHTML = JSON.parse(JSON.stringify(templateData));
        templateDataHTML.format = 'html';

        var mailOptions = {
            from: mailConfig().from,
            to: user.alternateEmail || user.email,
            subject: util.format('[%s] Password Reset', config.fqdn()),
            text: render('password_reset.ejs', templateDataText),
            html: render('password_reset.ejs', templateDataHTML)
        };

        enqueue(mailOptions);
    });
}

function appDied(app) {
    assert.strictEqual(typeof app, 'object');

    debug('Sending mail for app %s @ %s died', app.id, app.fqdn);

    getAdminEmails(function (error, adminEmails) {
        if (error) return console.log('Error getting admins', error);

        var mailOptions = {
            from: mailConfig().from,
            to: config.provider() === 'caas' ? 'support@cloudron.io' : adminEmails.join(', '),
            subject: util.format('[%s] App %s is down', config.fqdn(), app.fqdn),
            text: render('app_down.ejs', { fqdn: config.fqdn(), title: app.manifest.title, appFqdn: app.fqdn, format: 'text' })
        };

        enqueue(mailOptions);
    });
}

function boxUpdateAvailable(newBoxVersion, changelog) {
    assert.strictEqual(typeof newBoxVersion, 'string');
    assert(util.isArray(changelog));

    getAdminEmails(function (error, adminEmails) {
        if (error) return console.log('Error getting admins', error);

        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

            var converter = new showdown.Converter();

            var templateData = {
                fqdn: config.fqdn(),
                webadminUrl: config.adminOrigin(),
                newBoxVersion: newBoxVersion,
                changelog: changelog,
                changelogHTML: changelog.map(function (e) { return converter.makeHtml(e); }),
                cloudronName: cloudronName,
                cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar'
            };

            var templateDataText = JSON.parse(JSON.stringify(templateData));
            templateDataText.format = 'text';

            var templateDataHTML = JSON.parse(JSON.stringify(templateData));
            templateDataHTML.format = 'html';

             var mailOptions = {
                from: mailConfig().from,
                to: adminEmails.join(', '),
                subject: util.format('%s has a new update available', config.fqdn()),
                text: render('box_update_available.ejs', templateDataText),
                html: render('box_update_available.ejs', templateDataHTML)
            };

            enqueue(mailOptions);
        });
    });
}

function appUpdateAvailable(app, updateInfo) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof updateInfo, 'object');

    getAdminEmails(function (error, adminEmails) {
        if (error) return console.log('Error getting admins', error);

         var mailOptions = {
            from: mailConfig().from,
            to: adminEmails.join(', '),
            subject: util.format('[%s] Update available for %s', config.fqdn(), app.fqdn),
            text: render('app_update_available.ejs', { fqdn: config.fqdn(), webadminUrl: config.adminOrigin(), app: app, updateInfo: updateInfo, format: 'text' })
        };

        enqueue(mailOptions);
    });
}

function sendDigest(info) {
    assert.strictEqual(typeof info, 'object');

    getAdminEmails(function (error, adminEmails) {
        if (error) return console.log('Error getting admins', error);

        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

             var mailOptions = {
                from: mailConfig().from,
                to: adminEmails.join(', '),
                subject: util.format('[%s] Weekly event digest', config.fqdn()),
                text: render('digest.ejs', { fqdn: config.fqdn(), webadminUrl: config.adminOrigin(), cloudronName: cloudronName, info: info, format: 'text' })
            };

            enqueue(mailOptions);
        });
    });
}

function outOfDiskSpace(message) {
    assert.strictEqual(typeof message, 'string');

    getAdminEmails(function (error, adminEmails) {
        if (error) return console.log('Error getting admins', error);

        var mailOptions = {
            from: mailConfig().from,
            to: config.provider() === 'caas' ? 'support@cloudron.io' : adminEmails.join(', '),
            subject: util.format('[%s] Out of disk space alert', config.fqdn()),
            text: render('out_of_disk_space.ejs', { fqdn: config.fqdn(), message: message, format: 'text' })
        };

        sendMails([ mailOptions ]);
    });
}

function backupFailed(error) {
    var message = splatchError(error);

    getAdminEmails(function (error, adminEmails) {
        if (error) return console.log('Error getting admins', error);

        var mailOptions = {
            from: mailConfig().from,
            to: config.provider() === 'caas' ? 'support@cloudron.io' : adminEmails.join(', '),
            subject: util.format('[%s] Failed to backup', config.fqdn()),
            text: render('backup_failed.ejs', { fqdn: config.fqdn(), message: message, format: 'text' })
        };

        enqueue(mailOptions);
    });
}

function certificateRenewalError(domain, message) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof message, 'string');

    getAdminEmails(function (error, adminEmails) {
        if (error) return console.log('Error getting admins', error);

        var mailOptions = {
            from: mailConfig().from,
            to: config.provider() === 'caas' ? 'support@cloudron.io' : adminEmails.join(', '),
            subject: util.format('[%s] Certificate renewal error', domain),
            text: render('certificate_renewal_error.ejs', { domain: domain, message: message, format: 'text' })
        };

        sendMails([ mailOptions ]);
    });
}

function oomEvent(program, context) {
    assert.strictEqual(typeof program, 'string');
    assert.strictEqual(typeof context, 'string');

    getAdminEmails(function (error, adminEmails) {
        if (error) return console.log('Error getting admins', error);

        var mailOptions = {
            from: mailConfig().from,
            to: config.provider() === 'caas' ? 'support@cloudron.io' : adminEmails.join(', '),
            subject: util.format('[%s] %s exited unexpectedly', config.fqdn(), program),
            text: render('oom_event.ejs', { fqdn: config.fqdn(), program: program, context: context, format: 'text' })
        };

        sendMails([ mailOptions ]);
    });
}

// this function bypasses the queue intentionally. it is also expected to work without the mailer module initialized
// NOTE: crashnotifier should be able to send mail when there is no db
function unexpectedExit(program, context, callback) {
    assert.strictEqual(typeof program, 'string');
    assert.strictEqual(typeof context, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (config.provider() !== 'caas') return callback(); // no way to get admins without db access

    var mailOptions = {
        from: mailConfig().from,
        to: 'support@cloudron.io',
        subject: util.format('[%s] %s exited unexpectedly', config.fqdn(), program),
        text: render('unexpected_exit.ejs', { fqdn: config.fqdn(), program: program, context: context, format: 'text' })
    };

    sendMails([ mailOptions ], callback);
}

function sendFeedback(user, type, subject, description) {
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof subject, 'string');
    assert.strictEqual(typeof description, 'string');

    assert(type === exports.FEEDBACK_TYPE_TICKET ||
        type === exports.FEEDBACK_TYPE_FEEDBACK ||
        type === exports.FEEDBACK_TYPE_APP_MISSING ||
        type === exports.FEEDBACK_TYPE_UPGRADE_REQUEST ||
        type === exports.FEEDBACK_TYPE_APP_ERROR);

    var mailOptions = {
        from: mailConfig().from,
        to: 'support@cloudron.io',
        subject: util.format('[%s] %s - %s', type, config.fqdn(), subject),
        text: render('feedback.ejs', { fqdn: config.fqdn(), type: type, user: user, subject: subject, description: description, format: 'text'})
    };

    enqueue(mailOptions);
}

function _getMailQueue() {
    return gMailQueue;
}

function _clearMailQueue(callback) {
    gMailQueue = [];

    if (callback) callback();
}
