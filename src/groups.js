'use strict';

exports = module.exports = {
    GroupsError: GroupsError,

    create: create,
    remove: remove,
    get: get,
    update: update,
    getWithMembers: getWithMembers,
    getAll: getAll,
    getAllWithMembers: getAllWithMembers,

    getMembers: getMembers,
    addMember: addMember,
    setMembers: setMembers,
    removeMember: removeMember,
    isMember: isMember,

    getGroups: getGroups,

    setMembership: setMembership,
    getMembership: getMembership,

    count: count
};

var assert = require('assert'),
    constants = require('./constants.js'),
    DatabaseError = require('./databaseerror.js'),
    groupdb = require('./groupdb.js'),
    util = require('util'),
    uuid = require('uuid'),
    _ = require('underscore');

// http://dustinsenos.com/articles/customErrorsInNode
// http://code.google.com/p/v8/wiki/JavaScriptStackTraceApi
function GroupsError(reason, errorOrMessage) {
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
util.inherits(GroupsError, Error);
GroupsError.INTERNAL_ERROR = 'Internal Error';
GroupsError.ALREADY_EXISTS = 'Already Exists';
GroupsError.NOT_FOUND = 'Not Found';
GroupsError.BAD_FIELD = 'Field error';
GroupsError.NOT_EMPTY = 'Not Empty';
GroupsError.NOT_ALLOWED = 'Not Allowed';

// keep this in sync with validateUsername
function validateGroupname(name) {
    assert.strictEqual(typeof name, 'string');

    if (name.length < 1) return new GroupsError(GroupsError.BAD_FIELD, 'name must be atleast 1 char');
    if (name.length >= 200) return new GroupsError(GroupsError.BAD_FIELD, 'name too long');

    if (constants.RESERVED_NAMES.indexOf(name) !== -1) return new GroupsError(GroupsError.BAD_FIELD, 'name is reserved');

    // need to consider valid LDAP characters here (e.g '+' is reserved)
    if (/[^a-zA-Z0-9.-]/.test(name)) return new GroupsError(GroupsError.BAD_FIELD, 'name can only contain alphanumerals, hyphen and dot');

    return null;
}

function create(name, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof callback, 'function');

    // we store names in lowercase
    name = name.toLowerCase();

    var error = validateGroupname(name);
    if (error) return callback(error);

    var id = 'gid-' + uuid.v4();
    groupdb.add(id, name, function (error) {
        if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new GroupsError(GroupsError.ALREADY_EXISTS));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        callback(null, { id: id, name: name });
    });
}

function remove(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    groupdb.del(id, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new GroupsError(GroupsError.NOT_FOUND));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    groupdb.get(id, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new GroupsError(GroupsError.NOT_FOUND));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function getWithMembers(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    groupdb.getWithMembers(id, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new GroupsError(GroupsError.NOT_FOUND));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    groupdb.getAll(function (error, result) {
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function getAllWithMembers(callback) {
    assert.strictEqual(typeof callback, 'function');

    groupdb.getAllWithMembers(function (error, result) {
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function getMembers(groupId, callback) {
    assert.strictEqual(typeof groupId, 'string');
    assert.strictEqual(typeof callback, 'function');

    groupdb.getMembers(groupId, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new GroupsError(GroupsError.NOT_FOUND));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function getMembership(userId, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    groupdb.getMembership(userId, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new GroupsError(GroupsError.NOT_FOUND));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function setMembership(userId, groupIds, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert(Array.isArray(groupIds));
    assert.strictEqual(typeof callback, 'function');

    groupdb.setMembership(userId, groupIds, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new GroupsError(GroupsError.NOT_FOUND));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function addMember(groupId, userId, callback) {
    assert.strictEqual(typeof groupId, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    groupdb.addMember(groupId, userId, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new GroupsError(GroupsError.NOT_FOUND));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function setMembers(groupId, userIds, callback) {
    assert.strictEqual(typeof groupId, 'string');
    assert(Array.isArray(userIds));
    assert.strictEqual(typeof callback, 'function');

    groupdb.setMembers(groupId, userIds, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new GroupsError(GroupsError.NOT_FOUND, 'Invalid group or user id'));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function removeMember(groupId, userId, callback) {
    assert.strictEqual(typeof groupId, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    groupdb.removeMember(groupId, userId, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new GroupsError(GroupsError.NOT_FOUND));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function isMember(groupId, userId, callback) {
    assert.strictEqual(typeof groupId, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    groupdb.isMember(groupId, userId, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new GroupsError(GroupsError.NOT_FOUND));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        return callback(null, result);
    });
}

function update(groupId, data, callback) {
    assert.strictEqual(typeof groupId, 'string');
    assert(data && typeof data === 'object');
    assert.strictEqual(typeof callback, 'function');

    let error;
    if ('name' in data) {
        assert.strictEqual(typeof data.name, 'string');
        error = validateGroupname(data.name);
        if (error) return callback(error);
    }

    groupdb.update(groupId, _.pick(data, 'name'), function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new GroupsError(GroupsError.NOT_FOUND));
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function getGroups(userId, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    groupdb.getGroups(userId, function (error, results) {
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        callback(null, results);
    });
}

function count(callback) {
    assert.strictEqual(typeof callback, 'function');

    groupdb.count(function (error, count) {
        if (error) return callback(new GroupsError(GroupsError.INTERNAL_ERROR, error));

        callback(null, count);
    });
}
