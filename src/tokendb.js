/* jslint node: true */

'use strict';

exports = module.exports = {
    get: get,
    getByAccessToken: getByAccessToken,
    add: add,
    del: del,
    delByClientId: delByClientId,
    getByIdentifier: getByIdentifier,
    delByIdentifier: delByIdentifier,
    getByIdentifierAndClientId: getByIdentifierAndClientId,
    delByIdentifierAndClientId: delByIdentifierAndClientId,
    delExpired: delExpired,

    _clear: clear
};

var assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror');

var TOKENS_FIELDS = [ 'id', 'accessToken', 'identifier', 'clientId', 'scope', 'expires', 'name' ].join(',');

function getByAccessToken(accessToken, callback) {
    assert.strictEqual(typeof accessToken, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + TOKENS_FIELDS + ' FROM tokens WHERE accessToken = ? AND expires > ?', [ accessToken, Date.now() ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, result[0]);
    });
}

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + TOKENS_FIELDS + ' FROM tokens WHERE id = ?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, result[0]);
    });
}

function add(token, callback) {
    assert.strictEqual(typeof token, 'object');
    assert.strictEqual(typeof callback, 'function');

    let { id, accessToken, identifier, clientId, expires, scope, name } = token;

    assert.strictEqual(typeof accessToken, 'string');
    assert.strictEqual(typeof identifier, 'string');
    assert(typeof clientId === 'string' || clientId === null);
    assert.strictEqual(typeof expires, 'number');
    assert.strictEqual(typeof scope, 'string');
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('INSERT INTO tokens (id, accessToken, identifier, clientId, expires, scope, name) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [ id, accessToken, identifier, clientId, expires, scope, name ], function (error, result) {
            if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS));
            if (error || result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            callback(null);
        });
}

function del(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM tokens WHERE id = ?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(error);
    });
}

function delByClientId(clientId, callback) {
    assert.strictEqual(typeof clientId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM tokens WHERE clientId = ?', [ clientId ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        return callback(null);
    });
}

function getByIdentifier(identifier, callback) {
    assert.strictEqual(typeof identifier, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + TOKENS_FIELDS + ' FROM tokens WHERE identifier = ?', [ identifier ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null, results);
    });
}

function delByIdentifier(identifier, callback) {
    assert.strictEqual(typeof identifier, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM tokens WHERE identifier = ?', [ identifier ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        return callback(null);
    });
}

function getByIdentifierAndClientId(identifier, clientId, callback) {
    assert.strictEqual(typeof identifier, 'string');
    assert.strictEqual(typeof clientId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + TOKENS_FIELDS + ' FROM tokens WHERE identifier=? AND clientId=?', [ identifier, clientId ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, results);
    });
}

function delByIdentifierAndClientId(identifier, clientId, callback) {
    assert.strictEqual(typeof identifier, 'string');
    assert.strictEqual(typeof clientId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM tokens WHERE identifier = ? AND clientId = ?', [ identifier, clientId ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        return callback(null);
    });
}

function delExpired(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM tokens WHERE expires <= ?', [ Date.now() ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        return callback(null, result.affectedRows);
    });
}

function clear(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM tokens', function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

