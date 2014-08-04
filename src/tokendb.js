'use strict';

var DatabaseError = require('./databaseerror'),
    path = require('path'),
    uuid = require('node-uuid'),
    debug = require('debug')('box:tokendb'),
    database = require('./database.js'),
    assert = require('assert');

exports = module.exports = {
    generateToken: generateToken,
    get: get,
    getByUserId: getByUserId,
    add: add,
    del: del,
    delByUserId: delByUserId
};

function generateToken() {
    return uuid.v4();
}

function get(accessToken, callback) {
    assert(typeof accessToken === 'string');
    assert(typeof callback === 'function');

    database.get('SELECT * FROM tokens WHERE accessToken = ?', [ accessToken ], function (error, result) {
        if (error) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));

        if (typeof result === 'undefined') return callback(new DatabaseError(null, DatabaseError.NOT_FOUND));

        callback(null, result);
    });
}

function add(accessToken, userId, clientId, expires, callback) {
    assert(typeof accessToken === 'string');
    assert(typeof userId === 'string');
    assert(typeof clientId === 'string' || clientId === null);
    assert(typeof expires === 'string');
    assert(typeof callback === 'function');

    var data = {
        $accessToken: accessToken,
        $userId: userId,
        $clientId: clientId,
        $expires: expires
    };

    database.run('INSERT INTO tokens (accessToken, userId, clientId, expires) '
           + 'VALUES ($accessToken, $userId, $clientId, $expires)',
           data, function (error) {
        if (error && error.code === 'SQLITE_CONSTRAINT') return callback(new DatabaseError(error, DatabaseError.ALREADY_EXISTS));
        if (error || !this.lastID) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));

        callback(null);
    });
}

function del(accessToken, callback) {
    assert(typeof accessToken === 'string');
    assert(typeof callback === 'function');

    database.run('DELETE FROM tokens WHERE accessToken = ?', [ accessToken ], function (error) {
        if (error) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));
        if (this.changes !== 1) return callback(new DatabaseError(null, DatabaseError.NOT_FOUND));

        callback(error);
    });
}

function getByUserId(userId, callback) {
    assert(typeof userId === 'string');
    assert(typeof callback === 'function');

    database.get('SELECT * FROM tokens WHERE userId = ? LIMIT 1', [ userId ], function (error, result) {
        if (error) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));

        if (typeof result === 'undefined') return callback(new DatabaseError(null, DatabaseError.NOT_FOUND));

        return callback(null, result);
    });
}

function delByUserId(userId, callback) {
    assert(typeof userId === 'string');
    assert(typeof callback === 'function');

    database.run('DELETE FROM tokens WHERE userId = ?', [ userId ], function (error) {
        if (error) return callback(new DatabaseError(error, DatabaseError.INTERNAL_ERROR));
        if (this.changes !== 1) return callback(new DatabaseError(null, DatabaseError.NOT_FOUND));

        return callback(null);
    });
}
