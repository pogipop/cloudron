'use strict';

exports = module.exports = {
    get: get,
    getAll: getAll,
    getAllWithTokenCount: getAllWithTokenCount,
    getAllWithTokenCountByIdentifier: getAllWithTokenCountByIdentifier,
    add: add,
    del: del,
    getByAppId: getByAppId,
    getByAppIdAndType: getByAppIdAndType,

    upsert: upsert,

    delByAppId: delByAppId,
    delByAppIdAndType: delByAppIdAndType,

    _clear: clear,
    _addDefaultClients: addDefaultClients
};

var assert = require('assert'),
    async = require('async'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror.js');

var CLIENTS_FIELDS = [ 'id', 'appId', 'type', 'clientSecret', 'redirectURI', 'scope' ].join(',');
var CLIENTS_FIELDS_PREFIXED = [ 'clients.id', 'clients.appId', 'clients.type', 'clients.clientSecret', 'clients.redirectURI', 'clients.scope' ].join(',');

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + CLIENTS_FIELDS + ' FROM clients WHERE id = ?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, result[0]);
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + CLIENTS_FIELDS + ' FROM clients ORDER BY appId', function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null, results);
    });
}

function getAllWithTokenCount(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + CLIENTS_FIELDS_PREFIXED + ',COUNT(tokens.clientId) AS tokenCount FROM clients LEFT OUTER JOIN tokens ON clients.id=tokens.clientId GROUP BY clients.id', [], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null, results);
    });
}

function getAllWithTokenCountByIdentifier(identifier, callback) {
    assert.strictEqual(typeof identifier, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + CLIENTS_FIELDS_PREFIXED + ',COUNT(tokens.clientId) AS tokenCount FROM clients LEFT OUTER JOIN tokens ON clients.id=tokens.clientId WHERE tokens.identifier=? GROUP BY clients.id', [ identifier ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null, results);
    });
}

function getByAppId(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + CLIENTS_FIELDS + ' FROM clients WHERE appId = ? LIMIT 1', [ appId ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, result[0]);
    });
}

function getByAppIdAndType(appId, type, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + CLIENTS_FIELDS + ' FROM clients WHERE appId = ? AND type = ? LIMIT 1', [ appId, type ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, result[0]);
    });
}

function add(id, appId, type, clientSecret, redirectURI, scope, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof clientSecret, 'string');
    assert.strictEqual(typeof redirectURI, 'string');
    assert.strictEqual(typeof scope, 'string');
    assert.strictEqual(typeof callback, 'function');

    var data = [ id, appId, type, clientSecret, redirectURI, scope ];

    database.query('INSERT INTO clients (id, appId, type, clientSecret, redirectURI, scope) VALUES (?, ?, ?, ?, ?, ?)', data, function (error, result) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS));
        if (error || result.affectedRows === 0) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function upsert(id, appId, type, clientSecret, redirectURI, scope, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof clientSecret, 'string');
    assert.strictEqual(typeof redirectURI, 'string');
    assert.strictEqual(typeof scope, 'string');
    assert.strictEqual(typeof callback, 'function');

    var data = [ id, appId, type, clientSecret, redirectURI, scope ];

    database.query('REPLACE INTO clients (id, appId, type, clientSecret, redirectURI, scope) VALUES (?, ?, ?, ?, ?, ?)', data, function (error, result) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS));
        if (error || result.affectedRows === 0) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function del(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM clients WHERE id = ?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function delByAppId(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM clients WHERE appId=?', [ appId ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function delByAppIdAndType(appId, type, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM clients WHERE appId=? AND type=?', [ appId, type ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function clear(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM clients WHERE id!="cid-webadmin" AND id!="cid-sdk" AND id!="cid-cli"', function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function addDefaultClients(callback) {
    async.series([
        add.bind(null, 'cid-webadmin', 'Settings', 'built-in', 'secret-webadmin', 'https://admin-localhost', '*'),
        add.bind(null, 'cid-sdk', 'SDK', 'built-in', 'secret-sdk', 'https://admin-localhost', '*'),
        add.bind(null, 'cid-cli', 'Cloudron Tool', 'built-in', 'secret-cli', 'https://admin-localhost', '*')
    ], callback);
}
