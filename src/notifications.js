'use strict';

exports = module.exports = {
    NotificationsError: NotificationsError,

    add: add,
    get: get,
    ack: ack,
    getAllPaged: getAllPaged,

    // specialized notifications
    userAdded: userAdded,
    userRemoved: userRemoved,
    adminChanged: adminChanged,
    oomEvent: oomEvent,
    appDied: appDied,
    processCrash: processCrash,
    apptaskCrash: apptaskCrash
};

var assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:notifications'),
    mailer = require('./mailer.js'),
    notificationdb = require('./notificationdb.js'),
    safe = require('safetydance'),
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

function add(userId, eventId, title, message, action, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof title, 'string');
    assert.strictEqual(typeof message, 'string');
    assert.strictEqual(typeof action, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('add: ', userId, title, action);

    notificationdb.add({
        userId: userId,
        eventId: eventId,
        title: title,
        message: message,
        action: action
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

function userAdded(performedBy, eventId, user) {
    assert.strictEqual(typeof performedBy, 'string');
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof user, 'object');

    actionForAllAdmins([ performedBy, user.id ], function (admin, callback) {
        mailer.userAdded(admin.email, user);
        add(admin.id, eventId, 'User added', `User ${user.fallbackEmail} was added`, '/#/users', callback);
    }, function (error) {
        if (error) console.error(error);
    });
}

function userRemoved(performedBy, eventId, user) {
    assert.strictEqual(typeof performedBy, 'string');
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof user, 'object');

    actionForAllAdmins([ performedBy, user.id ], function (admin, callback) {
        mailer.userRemoved(admin.email, user);
        add(admin.id, eventId, 'User removed', `User ${user.username || user.email || user.fallbackEmail} was removed`, '/#/users', callback);
    }, function (error) {
        if (error) console.error(error);
    });
}

function adminChanged(performedBy, eventId, user) {
    assert.strictEqual(typeof performedBy, 'string');
    assert.strictEqual(typeof user, 'object');

    actionForAllAdmins([ performedBy, user.id ], function (admin, callback) {
        mailer.adminChanged(admin.email, user, user.admin);
        add(admin.id, eventId, 'Admin status change', `User ${user.username || user.email || user.fallbackEmail} ${user.admin ? 'is now an admin' : 'is no more an admin'}`, '/#/users', callback);
    }, function (error) {
        if (error) console.error(error);
    });
}

function oomEvent(eventId, program, context) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof program, 'string');
    assert.strictEqual(typeof context, 'object');

    // also send us a notification mail
    if (config.provider() === 'caas') mailer.oomEvent('support@cloudron.io', program, JSON.stringify(context, null, 4));

    actionForAllAdmins([], function (admin, callback) {
        mailer.oomEvent(admin.email, program, JSON.stringify(context, null, 4));

        var message;
        if (context.app) message = `The application ${context.app.manifest.title} with id ${context.app.id} ran out of memory.`;
        else message = `The container with id ${context.details.id} ran out of memory`;

        add(admin.id, eventId, 'Process died out-of-memory', message, context.app ? '/#/apps' : '', callback);
    }, function (error) {
        if (error) console.error(error);
    });
}

function appDied(eventId, app) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof app, 'object');

    // also send us a notification mail
    if (config.provider() === 'caas') mailer.appDied('support@cloudron.io', app);

    actionForAllAdmins([], function (admin, callback) {
        mailer.appDied(admin.email, app);
        add(admin.id, eventId, `App ${app.fqdn} is down`, `The application ${app.manifest.title} installed at ${app.fqdn} is not responding.`, '/#/apps', callback);
    }, function (error) {
        if (error) console.error(error);
    });
}

function processCrash(eventId, processName, crashLogFile) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof processName, 'string');
    assert.strictEqual(typeof crashLogFile, 'string');

    var subject = `${processName} exited unexpectedly`;
    var crashLogs = safe.fs.readFileSync(crashLogFile, 'utf8') || `No logs found at ${crashLogFile}`;

    // also send us a notification mail
    if (config.provider() === 'caas') mailer.unexpectedExit('support@cloudron.io', subject, crashLogs);

    actionForAllAdmins([], function (admin, callback) {
        mailer.unexpectedExit(admin.email, subject, crashLogs);
        add(admin.id, eventId, subject, 'Detailed logs have been sent to your email address.', '/#/system', callback);
    }, function (error) {
        if (error) console.error(error);
    });
}

function apptaskCrash(eventId, appId, crashLogFile) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof crashLogFile, 'string');

    var subject = `Apptask for ${appId} crashed`;
    var crashLogs = safe.fs.readFileSync(crashLogFile, 'utf8') || `No logs found at ${crashLogFile}`;

    // also send us a notification mail
    if (config.provider() === 'caas') mailer.unexpectedExit('support@cloudron.io', subject, crashLogs);

    actionForAllAdmins([], function (admin, callback) {
        mailer.unexpectedExit(admin.email, subject, crashLogs);
        add(admin.id, eventId, subject, 'Detailed logs have been sent to your email address.', '/#/system', callback);
    }, function (error) {
        if (error) console.error(error);
    });
}
