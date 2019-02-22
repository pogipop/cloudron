/* jslint node:true */

'use strict';

exports = module.exports = {
    get: get,
    getAll: getAll,
    set: set,
    _clear: clear
};

var assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror');

const SETTINGS_FIELDS = [ 'name', 'value' ].join(',');

function get(key, callback) {
    assert.strictEqual(typeof key, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query(`SELECT ${SETTINGS_FIELDS} FROM settings WHERE name = ?`, [ key ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, result[0].value);
    });
}

function getAll(callback) {
    database.query(`SELECT ${SETTINGS_FIELDS} FROM settings ORDER BY name`, function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null, results);
    });
}

function set(key, value, callback) {
    assert.strictEqual(typeof key, 'string');
    assert(value === null || typeof value === 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('INSERT INTO settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=VALUES(value)', [ key, value ], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error)); // don't rely on affectedRows here since it gives 2

        callback(null);
    });
}

function clear(callback) {
    database.query('DELETE FROM settings', function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(error);
    });
}
