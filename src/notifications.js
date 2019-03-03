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
    reboot: 'Reboot Required'
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
        message: message
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

function oomEvent(eventId, program, context, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof program, 'string');
    assert.strictEqual(typeof context, 'object');
    assert.strictEqual(typeof callback, 'function');

    // also send us a notification mail
    if (config.provider() === 'caas') mailer.oomEvent('support@cloudron.io', program, JSON.stringify(context, null, 4));

    actionForAllAdmins([], function (admin, done) {
        mailer.oomEvent(admin.email, program, JSON.stringify(context, null, 4));

        var message;
        if (context.app) message = `The application ${context.app.manifest.title} with id ${context.app.id} ran out of memory.`;
        else message = `The container with id ${context.details.id} ran out of memory`;

        add(admin.id, eventId, 'Process died out-of-memory', message, done);
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

function upsert(userId, eventId, title, message, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert(typeof eventId === 'string' || eventId === null);
    assert.strictEqual(typeof title, 'string');
    assert.strictEqual(typeof message, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('upsert: ', userId, title, message);

    notificationdb.upsert({
        userId: userId,
        eventId: eventId,
        title: title,
        message: message,
        acknowledged: !message
    }, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new NotificationsError(NotificationsError.NOT_FOUND, error.message));
        if (error) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

        callback(null, { id: result });
    });
}

function alert(id, message, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof message, 'string');
    assert.strictEqual(typeof callback, 'function');

    const title = ALERT_TITLES[id];
    if (!title) return callback();

    actionForAllAdmins([], function (admin, callback) {
        upsert(admin.id, null, title, message, callback);
    }, function (error) {
        if (error) console.error(error);
    });

    callback();
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
    case eventlog.ACTION_APP_OOM: return oomEvent(id, data.app ? data.app.id : data.containerId, { app: data.app, details: data }, callback);
    case eventlog.ACTION_APP_DOWN: return appDied(id, data.app, callback);
    case eventlog.ACTION_APP_UP: return appUp(id, data.app, callback);
    case eventlog.ACTION_APP_TASK_CRASH: return apptaskCrash(id, data.appId, data.crashLogFile, callback);
    case eventlog.ACTION_PROCESS_CRASH: return processCrash(id, data.processName, data.crashId, callback);
    default: return callback();
    }
}
