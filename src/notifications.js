'use strict';

exports = module.exports = {
    NotificationsError: NotificationsError,

    get: get,
    ack: ack,
    getAllPaged: getAllPaged,

    onEvent: onEvent,

    // NOTE: if you add an alert, be sure to add title below
    ALERT_BACKUP_CONFIG: 'backupConfig',
    ALERT_DISK_SPACE: 'diskSpace',
    ALERT_MAIL_STATUS: 'mailStatus',
    ALERT_REBOOT: 'reboot',
    ALERT_BOX_UPDATE: 'boxUpdate',

    alert: alert,

    // exported for testing
    _add: add
};

let assert = require('assert'),
    async = require('async'),
    custom = require('./custom.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:notifications'),
    eventlog = require('./eventlog.js'),
    mailer = require('./mailer.js'),
    notificationdb = require('./notificationdb.js'),
    settings = require('./settings.js'),
    users = require('./users.js'),
    util = require('util');

function NotificationsError(reason, errorOrMessage) {
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
util.inherits(NotificationsError, Error);
NotificationsError.INTERNAL_ERROR = 'Internal Error';
NotificationsError.NOT_FOUND = 'Not Found';

function add(userId, eventId, title, message, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert(typeof eventId === 'string' || eventId === null);
    assert.strictEqual(typeof title, 'string');
    assert.strictEqual(typeof message, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('add: ', userId, title);

    notificationdb.add({
        userId: userId,
        eventId: eventId,
        title: title,
        message: message,
        acknowledged: false
    }, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new NotificationsError(NotificationsError.NOT_FOUND, error.message));
        if (error) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

        callback(null, { id: result });
    });
}

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    notificationdb.get(id, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new NotificationsError(NotificationsError.NOT_FOUND));
        if (error) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

        callback(null, result);
    });
}

function ack(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    notificationdb.update(id, { acknowledged: true }, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new NotificationsError(NotificationsError.NOT_FOUND));
        if (error) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

        callback(null);
    });
}

// if acknowledged === null we return all, otherwise yes or no based on acknowledged as a boolean
function getAllPaged(userId, acknowledged, page, perPage, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert(acknowledged === null || typeof acknowledged === 'boolean');
    assert.strictEqual(typeof page, 'number');
    assert.strictEqual(typeof perPage, 'number');
    assert.strictEqual(typeof callback, 'function');

    notificationdb.listByUserIdPaged(userId, page, perPage, function (error, result) {
        if (error) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

        if (acknowledged === null) return callback(null, result);

        callback(null, result.filter(function (r) { return r.acknowledged === acknowledged; }));
    });
}

// Calls iterator with (admin, callback)
function actionForAllAdmins(skippingUserIds, iterator, callback) {
    assert(Array.isArray(skippingUserIds));
    assert.strictEqual(typeof iterator, 'function');
    assert.strictEqual(typeof callback, 'function');

    users.getAllAdmins(function (error, result) {
        if (error) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

        // filter out users we want to skip (like the user who did the action or the user the action was performed on)
        result = result.filter(function (r) { return skippingUserIds.indexOf(r.id) === -1; });

        async.each(result, iterator, callback);
    });
}

function userAdded(performedBy, eventId, user, callback) {
    assert.strictEqual(typeof performedBy, 'string');
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof callback, 'function');

    actionForAllAdmins([ performedBy, user.id ], function (admin, done) {
        mailer.userAdded(admin.email, user);
        add(admin.id, eventId, 'User added', `User ${user.fallbackEmail} was added`, done);
    }, callback);
}

function userRemoved(performedBy, eventId, user, callback) {
    assert.strictEqual(typeof performedBy, 'string');
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof callback, 'function');

    actionForAllAdmins([ performedBy, user.id ], function (admin, done) {
        mailer.userRemoved(admin.email, user);
        add(admin.id, eventId, 'User removed', `User ${user.username || user.email || user.fallbackEmail} was removed`, done);
    }, callback);
}

function adminChanged(performedBy, eventId, user, callback) {
    assert.strictEqual(typeof performedBy, 'string');
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof callback, 'function');

    actionForAllAdmins([ performedBy, user.id ], function (admin, done) {
        mailer.adminChanged(admin.email, user, user.admin);
        add(admin.id, eventId, 'Admin status change', `User ${user.username || user.email || user.fallbackEmail} ${user.admin ? 'is now an admin' : 'is no more an admin'}`, done);
    }, callback);
}

function oomEvent(eventId, app, addon, containerId, event, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof addon, 'object');
    assert.strictEqual(typeof containerId, 'string');
    assert.strictEqual(typeof callback, 'function');

    let title, message, program;
    if (app) {
        program = `App ${app.fqdn}`;
        title = `The application ${app.fqdn} (${app.manifest.title}) ran out of memory.`;
        message = 'The application has been restarted automatically. If you see this notification often, consider increasing the [memory limit](https://cloudron.io/documentation/apps/#increasing-the-memory-limit-of-an-app)';
    } else if (addon) {
        program = `${addon.name} service`;
        title = `The ${addon.name} service ran out of memory`;
        message = 'The service has been restarted automatically. If you see this notification often, consider increasing the [memory limit](https://cloudron.io/documentation/troubleshooting/#services)';
    } else { // this never happens currently
        program = `Container ${containerId}`;
        title = `The container ${containerId} ran out of memory`;
        message = 'The container has been restarted automatically. Consider increasing the [memory limit](https://docs.docker.com/v17.09/edge/engine/reference/commandline/update/#update-a-containers-kernel-memory-constraints)';
    }

    if (custom.spec().alerts.email) mailer.oomEvent(custom.spec().alerts.email, program, event);
    if (!custom.spec().alerts.notifyCloudronAdmins) return callback();

    actionForAllAdmins([], function (admin, done) {
        mailer.oomEvent(admin.email, program, event);

        add(admin.id, eventId, title, message, done);
    }, callback);
}

function appUp(eventId, app, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (custom.spec().alerts.email) mailer.appUp(custom.spec().alerts.email, app);
    if (!custom.spec().alerts.notifyCloudronAdmins) return callback();

    actionForAllAdmins([], function (admin, done) {
        mailer.appUp(admin.email, app);
        add(admin.id, eventId, `App ${app.fqdn} is back online`, `The application ${app.manifest.title} installed at ${app.fqdn} is back online.`, done);
    }, callback);
}

function appDied(eventId, app, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (custom.spec().alerts.email) mailer.appDied(custom.spec().alerts.email, app);
    if (!custom.spec().alerts.notifyCloudronAdmins) return callback();

    actionForAllAdmins([], function (admin, callback) {
        mailer.appDied(admin.email, app);
        add(admin.id, eventId, `App ${app.fqdn} is down`, `The application ${app.manifest.title} installed at ${app.fqdn} is not responding.`, callback);
    }, callback);
}

function appUpdated(eventId, app, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    const tmp = app.manifest.description.match(/<upstream>(.*)<\/upstream>/i);
    const upstreamVersion = (tmp && tmp[1]) ? tmp[1] : '';
    const title = upstreamVersion ? `${app.manifest.title} at ${app.fqdn} updated to ${upstreamVersion} (package version ${app.manifest.version})`
        : `${app.manifest.title} at ${app.fqdn} updated to package version ${app.manifest.version}`;

    actionForAllAdmins([], function (admin, done) {
        add(admin.id, eventId, title, `The application ${app.manifest.title} installed at https://${app.fqdn} was updated.\n\nChangelog:\n${app.manifest.changelog}\n\n`, function (error) {
            if (error) return callback(error);

            mailer.appUpdated(admin.email, app, function (error) {
                if (error) console.error('Failed to send app updated email', error); // non fatal
                done();
            });
        });
    }, callback);
}

function certificateRenewalError(eventId, vhost, errorMessage, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof vhost, 'string');
    assert.strictEqual(typeof errorMessage, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (custom.spec().alerts.email) mailer.certificateRenewalError(custom.spec().alerts.email, vhost, errorMessage);
    if (!custom.spec().alerts.notifyCloudronAdmins) return callback();

    actionForAllAdmins([], function (admin, callback) {
        mailer.certificateRenewalError(admin.email, vhost, errorMessage);
        add(admin.id, eventId, `Certificate renewal of ${vhost} failed`, `Failed to new certs of ${vhost}: ${errorMessage}. Renewal will be retried in 12 hours`, callback);
    }, callback);
}

function backupFailed(eventId, taskId, errorMessage, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof taskId, 'string');
    assert.strictEqual(typeof errorMessage, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (custom.spec().alerts.email) mailer.backupFailed(custom.spec().alerts.email, errorMessage, `${settings.adminOrigin()}/logs.html?taskId=${taskId}`);
    if (!custom.spec().alerts.notifyCloudronAdmins) return callback();

    actionForAllAdmins([], function (admin, callback) {
        mailer.backupFailed(admin.email, errorMessage, `${settings.adminOrigin()}/logs.html?taskId=${taskId}`);
        add(admin.id, eventId, 'Failed to backup', `Backup failed: ${errorMessage}. Logs are available [here](/logs.html?taskId=${taskId}). Will be retried in 4 hours`, callback);
    }, callback);
}

function alert(id, title, message, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof title, 'string');
    assert.strictEqual(typeof message, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`alert: id=${id} title=${title} message=${message}`);

    const acknowledged = !message;

    actionForAllAdmins([], function (admin, callback) {
        const data = {
            userId: admin.id,
            eventId: null,
            title: title,
            message: message,
            acknowledged: acknowledged,
            creationTime: new Date()
        };

        notificationdb.getByUserIdAndTitle(admin.id, title, function (error, result) {
            if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

            if (!result && acknowledged) return callback(); // do not add acked alerts

            let updateFunc = !result ? notificationdb.add.bind(null, data) : notificationdb.update.bind(null, result.id, data);

            updateFunc(function (error) {
                if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new NotificationsError(NotificationsError.NOT_FOUND, error.message));
                if (error) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

                callback(null);
            });
        });
    }, function (error) {
        if (error) console.error(error);

        callback();
    });
}

function onEvent(id, action, source, data, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof action, 'string');
    assert.strictEqual(typeof source, 'object');
    assert.strictEqual(typeof data, 'object');
    assert.strictEqual(typeof callback, 'function');

    switch (action) {
    case eventlog.ACTION_USER_ADD:
        return userAdded(source.userId, id, data.user, callback);

    case eventlog.ACTION_USER_REMOVE:
        return userRemoved(source.userId, id, data.user, callback);

    case eventlog.ACTION_USER_UPDATE:
        if (!data.adminStatusChanged) return callback();
        return adminChanged(source.userId, id, data.user, callback);

    case eventlog.ACTION_APP_OOM:
        return oomEvent(id, data.app, data.addon, data.containerId, data.event, callback);

    case eventlog.ACTION_APP_DOWN:
        return appDied(id, data.app, callback);

    case eventlog.ACTION_APP_UP:
        return appUp(id, data.app, callback);

    case eventlog.ACTION_APP_UPDATE_FINISH:
        return appUpdated(id, data.app, callback);

    case eventlog.ACTION_CERTIFICATE_RENEWAL:
    case eventlog.ACTION_CERTIFICATE_NEW:
        if (!data.errorMessage) return callback();
        return certificateRenewalError(id, data.domain, data.errorMessage, callback);

    case eventlog.ACTION_BACKUP_FINISH:
        if (!data.errorMessage || source.username !== 'cron') return callback();
        return backupFailed(id, data.taskId, data.errorMessage, callback); // only notify for automated backups

    default:
        return callback();
    }
}
