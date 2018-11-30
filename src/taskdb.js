'use strict';

exports = module.exports = {
    update: update,
    get: get
};

let assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror'),
    safe = require('safetydance'),
    _ = require('underscore');

const TASKS_FIELDS = [ 'id', 'argsJson', 'percent', 'message', 'errorMessage', 'creationTime', 'result', 'ts' ];

function postProcess(result) {
    assert.strictEqual(typeof result, 'object');

    assert(result.argsJson === null || typeof result.argsJson === 'string');
    result.args = safe.JSON.parse(result.argsJson) || {};
    delete result.argsJson;
}

function update(id, progress, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof progress, 'object');
    assert.strictEqual(typeof callback, 'function');

    let data = _.extend({ id: id }, progress);

    let keys = [ ],
        questionMarks = Array(Object.keys(data).length).fill('?').join(','),
        fields = [ ], values = [ ];

    for (var f in data) {
        let key, value;
        if (f === 'args') {
            key = 'argsJson';
            value = JSON.stringify(data[f]);
        } else {
            key = f;
            value = data[f];
        }
        keys.push(key);
        fields.push(`${key} = ?`);
        values.push(value); // for the INSERT fields
    }

    values = values.concat(values); // for the UPDATE fields

    database.query(`INSERT INTO tasks (${keys.join(', ')}) VALUES (${questionMarks}) ON DUPLICATE KEY UPDATE ${fields}`, values, function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + TASKS_FIELDS + ' FROM tasks WHERE id = ?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        postProcess(result[0]);

        callback(null, result[0]);
    });
}
