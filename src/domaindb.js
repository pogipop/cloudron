/* jslint node:true */

'use strict';

exports = module.exports = {
    add: add,
    get: get,
    getAll: getAll,
    update: update,
    del: del,
    clear: clear
};

var assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror'),
    safe = require('safetydance');

var DOMAINS_FIELDS = [ 'domain', 'zoneName', 'provider', 'configJson', 'tlsConfigJson', 'locked' ].join(',');

function postProcess(data) {
    data.config = safe.JSON.parse(data.configJson);
    data.tlsConfig = safe.JSON.parse(data.tlsConfigJson);
    delete data.configJson;
    delete data.tlsConfigJson;

    data.locked = !!data.locked; // make it bool

    return data;
}

function get(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query(`SELECT ${DOMAINS_FIELDS} FROM domains WHERE domain=?`, [ domain ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        postProcess(result[0]);

        callback(null, result[0]);
    });
}

function getAll(callback) {
    database.query(`SELECT ${DOMAINS_FIELDS} FROM domains ORDER BY domain`, function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(postProcess);

        callback(null, results);
    });
}

function add(name, domain, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'object');
    assert.strictEqual(typeof domain.zoneName, 'string');
    assert.strictEqual(typeof domain.provider, 'string');
    assert.strictEqual(typeof domain.config, 'object');
    assert.strictEqual(typeof domain.tlsConfig, 'object');
    assert.strictEqual(typeof callback, 'function');

    database.query('INSERT INTO domains (domain, zoneName, provider, configJson, tlsConfigJson) VALUES (?, ?, ?, ?, ?)', [ name, domain.zoneName, domain.provider, JSON.stringify(domain.config), JSON.stringify(domain.tlsConfig) ], function (error) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, error));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function update(name, domain, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'object');
    assert.strictEqual(typeof callback, 'function');

    var args = [ ], fields = [ ];
    for (var k in domain) {
        if (k === 'config') {
            fields.push('configJson = ?');
            args.push(JSON.stringify(domain[k]));
        } else if (k === 'tlsConfig') {
            fields.push('tlsConfigJson = ?');
            args.push(JSON.stringify(domain[k]));
        } else {
            fields.push(k + ' = ?');
            args.push(domain[k]);
        }
    }
    args.push(name);

    database.query('UPDATE domains SET ' + fields.join(', ') + ' WHERE domain=?', args, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DatabaseError(DatabaseError.NOT_FOUND));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function del(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM domains WHERE domain=?', [ domain ], function (error, result) {
        if (error && error.code === 'ER_ROW_IS_REFERENCED_2') return callback(new DatabaseError(DatabaseError.IN_USE));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function clear(callback) {
    database.query('DELETE FROM domains', function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(error);
    });
}
