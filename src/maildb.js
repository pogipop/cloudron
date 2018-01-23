'use strict';

exports = module.exports = {
    add: add,
    del: del,
    get: get,
    update: update,

    _clear: clear,

    TYPE_USER: 'user',
    TYPE_APP: 'app',
    TYPE_GROUP: 'group',

    _addDefaultDomain: addDefaultDomain
};

var assert = require('assert'),
    config = require('./config.js'),
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

    database.query('UPDATE mail SET ' + fields.join(', ') + ' WHERE domain=?', args, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DatabaseError(DatabaseError.NOT_FOUND));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function addDefaultDomain(callback) {
    assert(config.fqdn(), 'no fqdn set in config, cannot continue');

    add(config.fqdn(), function (error) {
        if (error && error.reason !== DatabaseError.ALREADY_EXISTS) return callback(error);
        callback();
    });
}
