'use strict';

exports = module.exports = {
    userAdded: userAdded,
    userRemoved: userRemoved,
    adminChanged: adminChanged,
    passwordReset: passwordReset,
    appUpdatesAvailable: appUpdatesAvailable,
    sendDigest: sendDigest,

    sendInvite: sendInvite,

    appUp: appUp,
    appDied: appDied,
    appUpdated: appUpdated,
    oomEvent: oomEvent,

    backupFailed: backupFailed,

    certificateRenewalError: certificateRenewalError,

    sendTestMail: sendTestMail,

    _mailQueue: [] // accumulate mails in test mode
};

var assert = require('assert'),
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
    util = require('util');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

var MAIL_TEMPLATES_DIR = path.join(__dirname, 'mail_templates');

// This will collect the most common details required for notification emails
function getMailConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settings.getCloudronName(function (error, cloudronName) {
        // this is not fatal
        if (error) {
            debug(error);
            cloudronName = 'Cloudron';
        }

        callback(null, {
            cloudronName: cloudronName,
            notificationFrom: `"${cloudronName}" <no-reply@${config.adminDomain()}>`
        });
    });
}

function sendMail(mailOptions, callback) {
    assert.strictEqual(typeof mailOptions, 'object');
    callback = callback || NOOP_CALLBACK;

    if (process.env.BOX_ENV === 'test') {
        exports._mailQueue.push(mailOptions);
        return callback();
    }

    docker.getContainer('mail').inspect(function (error, data) {
        if (error) return callback(error);

        var mailServerIp = safe.query(data, 'NetworkSettings.Networks.cloudron.IPAddress');
        if (!mailServerIp) return callback('Error querying mail server IP');

        // extract the relay token for auth
        const env = safe.query(data, 'Config.Env', null);
        if (!env) return callback(new Error('Error getting mail env'));
        const tmp = env.find(function (e) { return e.indexOf('CLOUDRON_RELAY_TOKEN') === 0; });
        if (!tmp) return callback(new Error('Error getting CLOUDRON_RELAY_TOKEN env var'));
        const relayToken = tmp.slice('CLOUDRON_RELAY_TOKEN'.length + 1); // +1 for the = sign
        if (!relayToken)  return callback(new Error('Error parsing CLOUDRON_RELAY_TOKEN'));

        var transport = nodemailer.createTransport(smtpTransport({
            host: mailServerIp,
            port: config.get('smtpPort'),
            auth: {
                user: mailOptions.authUser || `no-reply@${config.adminDomain()}`,
                pass: relayToken
            }
        }));

        transport.sendMail(mailOptions, function (error) {
            if (error) return callback(error);

            debug(`Email "${mailOptions.subject}" sent to ${mailOptions.to}`);

            callback(null);
        });
    });
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

function mailUserEvent(mailTo, user, event) {
    assert.strictEqual(typeof mailTo, 'string');
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof event, 'string');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: mailTo,
            subject: util.format('[%s] %s %s', mailConfig.cloudronName, user.username || user.fallbackEmail || user.email, event),
            text: render('user_event.ejs', { user: user, event: event, format: 'text' }),
        };

        sendMail(mailOptions);
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

        sendMail(mailOptions);
    });
}

function userAdded(mailTo, user) {
    assert.strictEqual(typeof mailTo, 'string');
    assert.strictEqual(typeof user, 'object');

    debug(`userAdded: Sending mail for added users ${user.fallbackEmail} to ${mailTo}`);

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

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
            to: mailTo,
            subject: util.format('[%s] User %s added', mailConfig.cloudronName, user.fallbackEmail),
            text: render('user_added.ejs', templateDataText),
            html: render('user_added.ejs', templateDataHTML)
        };

        sendMail(mailOptions);
    });
}

function userRemoved(mailTo, user) {
    assert.strictEqual(typeof mailTo, 'string');
    assert.strictEqual(typeof user, 'object');

    debug('Sending mail for userRemoved.', user.id, user.username, user.email);

    mailUserEvent(mailTo, user, 'was removed');
}

function adminChanged(mailTo, user, isAdmin) {
    assert.strictEqual(typeof mailTo, 'string');
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof isAdmin, 'boolean');

    debug('Sending mail for adminChanged');

    mailUserEvent(mailTo, user, isAdmin ? 'is now an admin' : 'is no more an admin');
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

        sendMail(mailOptions);
    });
}

function appUp(mailTo, app) {
    assert.strictEqual(typeof mailTo, 'string');
    assert.strictEqual(typeof app, 'object');

    debug('Sending mail for app %s @ %s up', app.id, app.fqdn);

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: mailTo,
            subject: util.format('[%s] App %s is back online', mailConfig.cloudronName, app.fqdn),
            text: render('app_up.ejs', { title: app.manifest.title, appFqdn: app.fqdn, format: 'text' })
        };

        sendMail(mailOptions);
    });
}

function appDied(mailTo, app) {
    assert.strictEqual(typeof mailTo, 'string');
    assert.strictEqual(typeof app, 'object');

    debug('Sending mail for app %s @ %s died', app.id, app.fqdn);

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: mailTo,
            subject: util.format('[%s] App %s is down', mailConfig.cloudronName, app.fqdn),
            text: render('app_down.ejs', { title: app.manifest.title, appFqdn: app.fqdn, format: 'text' })
        };

        sendMail(mailOptions);
    });
}

function appUpdated(mailTo, app) {
    assert.strictEqual(typeof mailTo, 'string');
    assert.strictEqual(typeof app, 'object');

    debug('Sending mail for app %s @ %s updated', app.id, app.fqdn);

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: mailTo,
            subject: util.format('[%s] App %s was updated', mailConfig.cloudronName, app.fqdn),
            text: render('app_updated.ejs', { title: app.manifest.title, appFqdn: app.fqdn, version: app.manifest.version, format: 'text' })
        };

        sendMail(mailOptions);
    });
}

function appUpdatesAvailable(mailTo, apps, hasSubscription, callback) {
    assert.strictEqual(typeof mailTo, 'string');
    assert.strictEqual(typeof apps, 'object');
    assert.strictEqual(typeof hasSubscription, 'boolean');
    assert.strictEqual(typeof callback, 'function');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var converter = new showdown.Converter();
        apps.forEach(function (app) {
            app.changelogHTML = converter.makeHtml(app.updateInfo.manifest.changelog);
        });

        var templateData = {
            webadminUrl: config.adminOrigin(),
            hasSubscription: hasSubscription,
            apps: apps,
            cloudronName: mailConfig.cloudronName,
            cloudronAvatarUrl: config.adminOrigin() + '/api/v1/cloudron/avatar'
        };

        var templateDataText = JSON.parse(JSON.stringify(templateData));
        templateDataText.format = 'text';

        var templateDataHTML = JSON.parse(JSON.stringify(templateData));
        templateDataHTML.format = 'html';

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: mailTo,
            subject: `New app updates available for ${mailConfig.cloudronName}`,
            text: render('app_updates_available.ejs', templateDataText),
            html: render('app_updates_available.ejs', templateDataHTML)
        };

        sendMail(mailOptions, callback);
    });
}

function sendDigest(mailTo, info, callback) {
    assert.strictEqual(typeof mailTo, 'string');
    assert.strictEqual(typeof info, 'object');
    assert.strictEqual(typeof callback, 'function');

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
            to: mailTo,
            subject: util.format('[%s] Weekly activity digest', mailConfig.cloudronName),
            text: render('digest.ejs', templateDataText),
            html: render('digest.ejs', templateDataHTML)
        };

        sendMail(mailOptions, callback);
    });
}

function backupFailed(mailTo, errorMessage, logUrl) {
    assert.strictEqual(typeof mailTo, 'string');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: mailTo,
            subject: util.format('[%s] Failed to backup', mailConfig.cloudronName),
            text: render('backup_failed.ejs', { cloudronName: mailConfig.cloudronName, message: errorMessage, logUrl: logUrl, format: 'text' })
        };

        sendMail(mailOptions);
    });
}

function certificateRenewalError(mailTo, domain, message) {
    assert.strictEqual(typeof mailTo, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof message, 'string');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: mailTo,
            subject: util.format('[%s] Certificate renewal error', domain),
            text: render('certificate_renewal_error.ejs', { domain: domain, message: message, format: 'text' })
        };

        sendMail(mailOptions);
    });
}

function oomEvent(mailTo, program, event) {
    assert.strictEqual(typeof mailTo, 'string');
    assert.strictEqual(typeof program, 'string');
    assert.strictEqual(typeof event, 'object');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            from: mailConfig.notificationFrom,
            to: mailTo,
            subject: util.format('[%s] %s was restarted (OOM)', mailConfig.cloudronName, program),
            text: render('oom_event.ejs', { cloudronName: mailConfig.cloudronName, program: program, event: JSON.stringify(event), format: 'text' })
        };

        sendMail(mailOptions);
    });
}

function sendTestMail(domain, email, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof email, 'string');
    assert.strictEqual(typeof callback, 'function');

    getMailConfig(function (error, mailConfig) {
        if (error) return debug('Error getting mail details:', error);

        var mailOptions = {
            authUser: `no-reply@${domain}`,
            from: `"${mailConfig.cloudronName}" <no-reply@${domain}>`,
            to: email,
            subject: util.format('Test Email from %s', mailConfig.cloudronName),
            text: render('test.ejs', { cloudronName: mailConfig.cloudronName, format: 'text'})
        };

        sendMail(mailOptions, callback);
    });
}
