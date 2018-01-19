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

function mailConfig() {
    return {
        from: '"Cloudron" <no-reply@' + config.fqdn() + '>'
    };
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

function getAdminEmails(callback) {
    users.getAllAdmins(function (error, admins) {
        if (error) return callback(error);

        if (admins.length === 0) return callback(new Error('No admins on this cloudron')); // box not activated yet

        var adminEmails = [ ];
        if (admins[0].alternateEmail) adminEmails.push(admins[0].alternateEmail);
        admins.forEach(function (admin) { adminEmails.push(admin.email); });

        callback(null, adminEmails);
    });
}

function mailUserEventToAdmins(user, event) {
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof event, 'string');

    settings.getCloudronName(function (error, cloudronName) {
        if (error) {
            debug(error);
            cloudronName = 'Cloudron';
        }

        getAdminEmails(function (error, adminEmails) {
            if (error) return debug('Error getting admins', error);

            adminEmails = _.difference(adminEmails, [ user.email ]);

            var mailOptions = {
                from: mailConfig().from,
                to: adminEmails.join(', '),
                subject: util.format('[%s] %s %s', cloudronName, user.username || user.alternateEmail || user.email, event),
                text: render('user_event.ejs', { user: user, event: event, format: 'text' }),
            };

            enqueue(mailOptions);
        });
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
        if (error) return debug('Error getting admins', error);

        adminEmails = _.difference(adminEmails, [ user.email ]);

        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

            var templateData = {
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
                subject: util.format('[%s] User %s added', cloudronName, user.alternateEmail || user.email),
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
            subject: util.format('[%s] Password Reset', cloudronName),
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
        if (error) return debug('Error getting admins', error);

        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

            var mailOptions = {
                from: mailConfig().from,
                to: config.provider() === 'caas' ? 'support@cloudron.io' : adminEmails.join(', '),
                subject: util.format('[%s] App %s is down', cloudronName, app.fqdn),
                text: render('app_down.ejs', { title: app.manifest.title, appFqdn: app.fqdn, format: 'text' })
            };

            enqueue(mailOptions);
        });
    });
}

function boxUpdateAvailable(hasSubscription, newBoxVersion, changelog) {
    assert.strictEqual(typeof hasSubscription, 'boolean');
    assert.strictEqual(typeof newBoxVersion, 'string');
    assert(util.isArray(changelog));

    getAdminEmails(function (error, adminEmails) {
        if (error) return debug('Error getting admins', error);

        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

            var converter = new showdown.Converter();

            var templateData = {
                webadminUrl: config.adminOrigin(),
                newBoxVersion: newBoxVersion,
                hasSubscription: hasSubscription,
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
                subject: util.format('%s has a new update available', cloudronName),
                text: render('box_update_available.ejs', templateDataText),
                html: render('box_update_available.ejs', templateDataHTML)
            };

            enqueue(mailOptions);
        });
    });
}

function appUpdateAvailable(app, hasSubscription, info) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof hasSubscription, 'boolean');
    assert.strictEqual(typeof info, 'object');

    getAdminEmails(function (error, adminEmails) {
        if (error) return debug('Error getting admins', error);

        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

            var converter = new showdown.Converter();

            var templateData = {
                webadminUrl: config.adminOrigin(),
                hasSubscription: hasSubscription,
                app: app,
                updateInfo: info,
                changelogHTML: converter.makeHtml(info.manifest.changelog),
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
                subject: util.format('App %s has a new update available', app.fqdn),
                text: render('app_update_available.ejs', templateDataText),
                html: render('app_update_available.ejs', templateDataHTML)
            };

            enqueue(mailOptions);
        });
    });
}

function sendDigest(info) {
    assert.strictEqual(typeof info, 'object');

    getAdminEmails(function (error, adminEmails) {
        if (error) return debug('Error getting admins', error);

        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

            var templateData = {
                webadminUrl: config.adminOrigin(),
                cloudronName: cloudronName,
                cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar',
                info: info
            };

            var templateDataText = JSON.parse(JSON.stringify(templateData));
            templateDataText.format = 'text';

            var templateDataHTML = JSON.parse(JSON.stringify(templateData));
            templateDataHTML.format = 'html';

            var mailOptions = {
                from: mailConfig().from,
                to: adminEmails.join(', '),
                subject: util.format('[%s] Cloudron - Weekly activity digest', cloudronName),
                text: render('digest.ejs', templateDataText),
                html: render('digest.ejs', templateDataHTML)
            };

            enqueue(mailOptions);
        });
    });
}

function outOfDiskSpace(message) {
    assert.strictEqual(typeof message, 'string');

    getAdminEmails(function (error, adminEmails) {
        if (error) return debug('Error getting admins', error);

        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

            var mailOptions = {
                from: mailConfig().from,
                to: config.provider() === 'caas' ? 'support@cloudron.io' : adminEmails.join(', '),
                subject: util.format('[%s] Out of disk space alert', cloudronName),
                text: render('out_of_disk_space.ejs', { cloudronName: cloudronName, message: message, format: 'text' })
            };

            sendMails([ mailOptions ]);
        });
    });
}

function backupFailed(error) {
    var message = splatchError(error);

    getAdminEmails(function (error, adminEmails) {
        if (error) return debug('Error getting admins', error);

        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

            var mailOptions = {
                from: mailConfig().from,
                to: config.provider() === 'caas' ? 'support@cloudron.io' : adminEmails.join(', '),
                subject: util.format('[%s] Failed to backup', cloudronName),
                text: render('backup_failed.ejs', { cloudronName: cloudronName, message: message, format: 'text' })
            };

            enqueue(mailOptions);
        });
    });
}

function certificateRenewalError(domain, message) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof message, 'string');

    getAdminEmails(function (error, adminEmails) {
        if (error) return debug('Error getting admins', error);

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
        if (error) return debug('Error getting admins', error);

        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                debug(error);
                cloudronName = 'Cloudron';
            }

            var mailOptions = {
                from: mailConfig().from,
                to: config.provider() === 'caas' ? 'support@cloudron.io' : adminEmails.join(', '),
                subject: util.format('[%s] %s exited unexpectedly', cloudronName, program),
                text: render('oom_event.ejs', { cloudronName: cloudronName, program: program, context: context, format: 'text' })
            };

            sendMails([ mailOptions ]);
        });
    });
}

// this function bypasses the queue intentionally. it is also expected to work without the mailer module initialized
// NOTE: crashnotifier should be able to send mail when there is no db
function unexpectedExit(program, context, callback) {
    assert.strictEqual(typeof program, 'string');
    assert.strictEqual(typeof context, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (config.provider() !== 'caas') return callback(); // no way to get admins without db access

    settings.getCloudronName(function (error, cloudronName) {
        if (error) {
            debug(error);
            cloudronName = 'Cloudron';
        }

        var mailOptions = {
            from: mailConfig().from,
            to: 'support@cloudron.io',
            subject: util.format('[%s] %s exited unexpectedly', cloudronName, program),
            text: render('unexpected_exit.ejs', { cloudronName: cloudronName, program: program, context: context, format: 'text' })
        };

        sendMails([ mailOptions ], callback);
    });
}

function sendTestMail(email) {
    assert.strictEqual(typeof email, 'string');

    settings.getCloudronName(function (error, cloudronName) {
        if (error) {
            debug(error);
            cloudronName = 'Cloudron';
        }

        var mailOptions = {
            from: mailConfig().from,
            to: email,
            subject: util.format('Test Email from %s', cloudronName),
            text: render('test.ejs', { cloudronName: cloudronName, format: 'text'})
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
