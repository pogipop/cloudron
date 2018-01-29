'use strict';

exports = module.exports = {
    add: add,
    del: del,
    get: get,
    getAll: getAll,
    update: update,

    _clear: clear,

    TYPE_USER: 'user',
    TYPE_APP: 'app',
    TYPE_GROUP: 'group'
};

var assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror.js'),
    safe = require('safetydance');

var MAILDB_FIELDS = [ 'domain', 'enabled', 'mailFromValidation', 'catchAllJson', 'relayJson' ].join(',');

function postProcess(data) {
    data.enabled = !!data.enabled; // int to boolean
    data.mailFromValidation = !!data.mailFromValidation; // int to boolean

    data.catchAll = safe.JSON.parse(data.catchAllJson) || [ ];
    delete data.catchAllJson;

    data.relay = safe.JSON.parse(data.relayJson) || { provider: 'cloudron-smtp' };
    delete data.relayJson;

    return data;
}

function add(domain, callback) {
    assert.strictEqual(typeof domain, 'string');

    database.query('INSERT INTO mail (domain) VALUES (?)', [ domain ], function (error) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, 'mail domain already exists'));
        if (error && error.code === 'ER_NO_REFERENCED_ROW_2') return callback(new DatabaseError(DatabaseError.NOT_FOUND), 'no such domain');
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function clear(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('TRUNCATE TABLE mail', [], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        callback(null);
    });
}

function del(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    // deletes aliases as well
    database.query('DELETE FROM mail WHERE domain=?', [ domain ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function get(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILDB_FIELDS + ' FROM mail WHERE domain = ?', [ domain ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, postProcess(results[0]));
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILDB_FIELDS + ' FROM mail ORDER BY domain', function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(function (result) { postProcess(result); });

        callback(null, results);
    });
}

function update(domain, data, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof data, 'object');
    assert.strictEqual(typeof callback, 'function');

    var args = [ ];
    var fields = [ ];
    for (var k in data) {
        if (k === 'catchAll') {
            fields.push('catchAllJson = ?');
            args.push(JSON.stringify(data[k]));
        } else if (k === 'relay') {
            fields.push('relayJson = ?');
            args.push(JSON.stringify(data[k]));
        } else {
            fields.push(k + ' = ?');
            args.push(data[k]);
        }
    }
    args.push(domain);

    database.query('UPDATE mail SET ' + fields.join(', ') + ' WHERE domain=?', args, function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}
