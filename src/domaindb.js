/* jslint node:true */

'use strict';

exports = module.exports = {
    add: add,
    get: get,
    getAll: getAll,
    update: update,
    upsert: upsert,
    del: del,

    _clear: clear,
    _addDefaultDomain: addDefaultDomain
};

var assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror'),
    config = require('./config.js'),
    safe = require('safetydance');

function postProcess(data) {
    data.config = safe.JSON.parse(data.configJson);
    data.provider = data.config.provider; // FIXME, make provider a db column
    delete data.configJson;

    return data;
}

function get(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT * FROM domains WHERE domain=?', [ domain ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        postProcess(result[0]);

        callback(null, result[0]);
    });
}

function getAll(callback) {
    database.query('SELECT * FROM domains ORDER BY domain', function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(postProcess);

        callback(null, results);
    });
}

function add(domain, zoneName, config, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof callback, 'function');

    database.query('INSERT INTO domains (domain, zoneName, configJson) VALUES (?, ?, ?)', [ domain, zoneName, JSON.stringify(config) ], function (error) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, error));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function upsert(domain, zoneName, config, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof callback, 'function');

    database.query('REPLACE INTO domains (domain, zoneName, configJson) VALUES (?, ?, ?)', [ domain, zoneName, JSON.stringify(config) ], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function update(domain, config, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof callback, 'function');

    database.query('UPDATE domains SET configJson=? WHERE domain=?', [ JSON.stringify(config), domain ], function (error) {
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
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function clear(callback) {
    database.query('DELETE FROM domains', function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(error);
    });
}

function addDefaultDomain(callback) {
    assert(config.fqdn(), 'no fqdn set in config, cannot continue');

    add(config.fqdn(), config.zoneName(), { provider: 'manual' }, function (error) {
        if (error && error.reason !== DatabaseError.ALREADY_EXISTS) return callback(error);
        callback();
    });
}
