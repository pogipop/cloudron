'use strict';

exports = module.exports = {
    setProgress: setProgress,
    getProgress: getProgress
};

let assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror'),
    _ = require('underscore');

const TASKS_FIELDS = [ 'id', 'percent', 'message', 'detail', 'creationTime', 'result', 'ts' ];

function setProgress(id, progress, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof progress, 'object');
    assert.strictEqual(typeof callback, 'function');

    let data = _.extend({ id: id }, progress);

    let keys = [ ],
        questionMarks = Array(Object.keys(data).length).fill('?').join(','),
        fields = [ ], values = [ ];

    for (var f in data) {
        keys.push(f);
        fields.push(`${f} = ?`);
        values.push(data[f]); // for the INSERT fields
    }

    values = values.concat(values); // for the UPDATE fields

    database.query(`INSERT INTO tasks (${keys.join(', ')}) VALUES (${questionMarks}) ON DUPLICATE KEY UPDATE ${fields}`, values, function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function getProgress(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + TASKS_FIELDS + ' FROM tasks WHERE id = ?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, result[0]);
    });
}
