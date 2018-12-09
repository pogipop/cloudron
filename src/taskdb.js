'use strict';

exports = module.exports = {
    get: get,
    add: add,
    update: update,
    del: del
};

let assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror'),
    safe = require('safetydance');

const TASKS_FIELDS = [ 'id', 'type', 'argsJson', 'percent', 'message', 'errorMessage', 'creationTime', 'result', 'ts' ];

function postProcess(result) {
    assert.strictEqual(typeof result, 'object');

    assert(result.argsJson === null || typeof result.argsJson === 'string');
    result.args = safe.JSON.parse(result.argsJson) || {};
    delete result.argsJson;

    result.id = String(result.id);
}

function add(task, callback) {
    assert.strictEqual(typeof task, 'object');
    assert.strictEqual(typeof callback, 'function');

    const query = 'INSERT INTO tasks (type, argsJson, percent, message) VALUES (?, ?, ?, ?)';
    const args = [ task.type, JSON.stringify(task.args), task.percent, task.message ];

    database.query(query, args, function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null, String(result.insertId));
    });
}

function update(id, data, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof data, 'object');
    assert.strictEqual(typeof callback, 'function');

    let args = [ ];
    let fields = [ ];
    for (let k in data) {
        fields.push(k + ' = ?');
        args.push(data[k]);
    }
    args.push(id);

    database.query('UPDATE tasks SET ' + fields.join(', ') + ' WHERE id = ?', args, function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        return callback(null);
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

function del(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM tasks WHERE id = ?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}
