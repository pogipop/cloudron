'use strict';

exports = module.exports = {
    get: get,
    add: add,
    update: update,
    del: del,
    listByTypePaged: listByTypePaged
};

let assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror'),
    safe = require('safetydance');

const TASKS_FIELDS = [ 'id', 'type', 'argsJson', 'percent', 'message', 'errorMessage', 'creationTime', 'resultJson', 'ts' ];

function postProcess(task) {
    assert.strictEqual(typeof task, 'object');

    assert(task.argsJson === null || typeof task.argsJson === 'string');
    task.args = safe.JSON.parse(task.argsJson) || [];
    delete task.argsJson;

    task.id = String(task.id);

    task.result = JSON.parse(task.resultJson);
    delete task.resultJson;
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
        if (k === 'result') {
            fields.push('resultJson = ?');
            args.push(JSON.stringify(data[k]));
        } else {
            fields.push(k + ' = ?');
            args.push(data[k]);
        }
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

function listByTypePaged(type, page, perPage, callback) {
    assert(typeof type === 'string' || type === null);
    assert.strictEqual(typeof page, 'number');
    assert.strictEqual(typeof perPage, 'number');
    assert.strictEqual(typeof callback, 'function');

    var data = [];
    var query = 'SELECT ' + TASKS_FIELDS + ' FROM tasks';

    if (type) {
        query += ' WHERE TYPE=?';
        data.push(type);
    }

    query += ' ORDER BY creationTime DESC, id DESC LIMIT ?,?'; // put latest task first

    data.push((page-1)*perPage);
    data.push(perPage);

    database.query(query, data, function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(postProcess);

        callback(null, results);
    });
}
