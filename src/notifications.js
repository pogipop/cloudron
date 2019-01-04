'use strict';

exports = module.exports = {
    NotificationsError: NotificationsError,

    add: add,
    get: get,
    ack: ack,
    getAllPaged: getAllPaged,

    // specialized notifications
    userAdded: userAdded
};

var assert = require('assert'),
    async = require('async'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:notifications'),
    mailer = require('./mailer.js'),
    notificationdb = require('./notificationdb.js'),
    users = require('./users.js'),
    util = require('util');

const NOOP_CALLBACK = function (error) { if (error) debug(error); };

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

function add(userId, title, message, action, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof title, 'string');
    assert.strictEqual(typeof message, 'string');
    assert.strictEqual(typeof action, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('add: ', userId, title, action);

    notificationdb.add({
        userId: userId,
        title: title,
        message: message,
        action: action
    }, function (error, result) {
        if (error) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

        callback(null, { id: result });
    });
}

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('get: ', id);

    notificationdb.get(id, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new NotificationsError(NotificationsError.NOT_FOUND));
        if (error) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

        callback(null, result);
    });
}

function ack(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('ack: ', id);

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

function userAdded(user, callback) {
    assert.strictEqual(typeof user, 'object');
    assert(typeof callback === 'undefined' || typeof callback === 'function');

    callback = callback || NOOP_CALLBACK;

    users.getAllAdmins(function (error, result) {
        if (error) return callback(new NotificationsError(NotificationsError.INTERNAL_ERROR, error));

        async.each(result, function (admin, callback) {
            mailer.userAdded(admin.email, user);
            add(admin.id, 'User added', `User ${user.fallbackEmail} was added`, '', callback);
        }, callback);
    });
}
