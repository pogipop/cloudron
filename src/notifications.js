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
    config = require('./config.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:notifications'),
    eventlog = require('./eventlog.js'),
    mailer = require('./mailer.js'),
    notificationdb = require('./notificationdb.js'),
    path = require('path'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    users = require('./users.js'),
    util = require('util');

// These titles are matched for upsert
const ALERT_TITLES = {
    backupConfig: 'Backup configuration is unsafe',
    diskSpace: 'Out of Disk Space',
    mailStatus: 'Email is not configured properly',
    reboot: 'Reboot Required',
    boxUpdate: 'New Cloudron Update Available'
};

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

    // also send us a notification mail
    if (config.provider() === 'caas') mailer.oomEvent('support@cloudron.io', program, event);

    actionForAllAdmins([], function (admin, done) {
        mailer.oomEvent(admin.email, program, event);

        add(admin.id, eventId, title, message, done);
    }, callback);
}

function appUp(eventId, app, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    // also send us a notification mail
    if (config.provider() === 'caas') mailer.appUp('support@cloudron.io', app);

    actionForAllAdmins([], function (admin, done) {
        mailer.appUp(admin.email, app);
        add(admin.id, eventId, `App ${app.fqdn} is back online`, `The application ${app.manifest.title} installed at ${app.fqdn} is back online.`, done);
    }, callback);
}

function appDied(eventId, app, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    // also send us a notification mail
    if (config.provider() === 'caas') mailer.appDied('support@cloudron.io', app);

    actionForAllAdmins([], function (admin, callback) {
        mailer.appDied(admin.email, app);
        add(admin.id, eventId, `App ${app.fqdn} is down`, `The application ${app.manifest.title} installed at ${app.fqdn} is not responding.`, callback);
    }, callback);
}

function processCrash(eventId, processName, crashId, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof processName, 'string');
    assert.strictEqual(typeof crashId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var subject = `${processName} exited unexpectedly`;
    var crashLogs = safe.fs.readFileSync(path.join(paths.CRASH_LOG_DIR, crashId, '.log'), 'utf8') || `No logs found at ${crashId}.log`;

    // also send us a notification mail
    if (config.provider() === 'caas') mailer.unexpectedExit('support@cloudron.io', subject, crashLogs);

    actionForAllAdmins([], function (admin, callback) {
        mailer.unexpectedExit(admin.email, subject, crashLogs);
        add(admin.id, eventId, subject, `The service has been restarted automatically. Crash logs are available [here](/logs.html?crashId=${crashId}).`, callback);
    }, callback);
}

function apptaskCrash(eventId, appId, crashLogFile, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof crashLogFile, 'string');
    assert.strictEqual(typeof callback, 'function');

    var subject = `Apptask for ${appId} crashed`;
    var crashLogs = safe.fs.readFileSync(crashLogFile, 'utf8') || `No logs found at ${crashLogFile}`;

    // also send us a notification mail
    if (config.provider() === 'caas') mailer.unexpectedExit('support@cloudron.io', subject, crashLogs);

    actionForAllAdmins([], function (admin, done) {
        mailer.unexpectedExit(admin.email, subject, crashLogs);
        add(admin.id, eventId, subject, 'Detailed logs have been sent to your email address.', done);
    }, callback);
}

function certificateRenewalError(eventId, vhost, errorMessage, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof vhost, 'string');
    assert.strictEqual(typeof errorMessage, 'string');
    assert.strictEqual(typeof callback, 'function');

    actionForAllAdmins([], function (admin, callback) {
        mailer.certificateRenewalError(vhost, errorMessage);
        add(admin.id, eventId, `Certificate renewal of ${vhost} failed`, `Failed to new certs of ${vhost}: ${errorMessage}. Renewal will be retried in 12 hours`, callback);
    }, callback);
}

function backupFailed(eventId, taskId, errorMessage, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof taskId, 'string');
    assert.strictEqual(typeof errorMessage, 'string');
    assert.strictEqual(typeof callback, 'function');

    actionForAllAdmins([], function (admin, callback) {
        mailer.backupFailed(errorMessage, `${config.adminOrigin()}/logs.html?taskId=${taskId}`);
        add(admin.id, eventId, 'Failed to backup', `Backup failed: ${errorMessage}. Logs are available [here](/logs.html?taskId=${taskId}). Will be retried in 4 hours`, callback);
    }, callback);
}

function upsert(userId, eventId, title, message, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert(typeof eventId === 'string' || eventId === null);
    assert.strictEqual(typeof title, 'string');
    assert.strictEqual(typeof message, 'string');
    assert.strictEqual(typeof callback, 'function');

    const acknowledged = !message;

    const data = {
        userId: userId,
        eventId: eventId,
        title: title,
        message: message,
        acknowledged: acknowledged
    };

    notificationdb.getByUserIdAndTitle(userId, title, function (error, result) {
        if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

        if (!result && acknowledged) return callback(); // do not add acked alerts

        let updateFunc = !result ? notificationdb.add.bind(null, data) : notificationdb.update.bind(null, result.id, data);

        updateFunc(function (error) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new NotificationsError(NotificationsError.NOT_FOUND, error.message));
            if (error) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

            callback(null);
        });
    });
}

function alert(id, message, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof message, 'string');
    assert.strictEqual(typeof callback, 'function');

    const title = ALERT_TITLES[id];
    if (!title) return callback();

    debug(`alert: id=${id} title=${title} message=${message}`);

    actionForAllAdmins([], function (admin, callback) {
        upsert(admin.id, null, title, message, callback);
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
    case eventlog.ACTION_USER_ADD: return userAdded(source.userId, id, data.user, callback);
    case eventlog.ACTION_USER_REMOVE: return userRemoved(source.userId, id, data.user, callback);
    case eventlog.ACTION_USER_UPDATE: return data.adminStatusChanged ? adminChanged(source.userId, id, data.user, callback) : callback();
    case eventlog.ACTION_APP_OOM: return oomEvent(id, data.app, data.addon, data.containerId, data.event, callback);
    case eventlog.ACTION_APP_DOWN: return appDied(id, data.app, callback);
    case eventlog.ACTION_APP_UP: return appUp(id, data.app, callback);
    case eventlog.ACTION_APP_TASK_CRASH: return apptaskCrash(id, data.appId, data.crashLogFile, callback);
    case eventlog.ACTION_PROCESS_CRASH: return processCrash(id, data.processName, data.crashId, callback);
    case eventlog.ACTION_CERTIFICATE_RENEWAL:
    case eventlog.ACTION_CERTIFICATE_NEW:
        return data.errorMessage ? certificateRenewalError(id, data.domain, data.errorMessage, callback): callback();

    case eventlog.ACTION_BACKUP_FINISH: return data.errorMessage ? backupFailed(id, data.taskId, data.errorMessage, callback) : callback();

    default: return callback();
    }
}
