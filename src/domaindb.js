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

var DOMAINS_FIELDS = [ 'domain', 'zoneName', 'provider', 'configJson' ].join(',');

function postProcess(data) {
    data.config = safe.JSON.parse(data.configJson);
    delete data.configJson;

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
    assert.strictEqual(typeof domain.zoneName, 'string');
    assert.strictEqual(typeof domain.provider, 'string');
    assert.strictEqual(typeof domain.config, 'object');
    assert.strictEqual(typeof callback, 'function');

    database.query('INSERT INTO domains (domain, zoneName, provider, configJson) VALUES (?, ?, ?, ?)', [ name, domain.zoneName, domain.provider, JSON.stringify(domain.config) ], function (error) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, error));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function upsert(domain, zoneName, provider, config, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof zoneName, 'string');
    assert.strictEqual(typeof provider, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof callback, 'function');

    database.query('REPLACE INTO domains (domain, zoneName, provider, configJson) VALUES (?, ?, ?, ?)', [ domain, zoneName, provider, JSON.stringify(config) ], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function update(domain, provider, config, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof provider, 'string');
    assert.strictEqual(typeof config, 'object');
    assert.strictEqual(typeof callback, 'function');

    database.query('UPDATE domains SET provider=?, configJson=? WHERE domain=?', [ provider, JSON.stringify(config), domain ], function (error) {
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

    add(config.fqdn(), { zoneName: config.zoneName(), provider: 'manual', config: { } }, function (error) {
        if (error && error.reason !== DatabaseError.ALREADY_EXISTS) return callback(error);
        callback();
    });
}
