'use strict';

exports = module.exports = {
    get: get,
    add: add,
    update: update,
    del: del,
    listByUserIdPaged: listByUserIdPaged
};

let assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror');

const NOTIFICATION_FIELDS = [ 'id', 'userId', 'eventId', 'title', 'message', 'action', 'creationTime', 'acknowledged' ];

function postProcess(result) {
    assert.strictEqual(typeof result, 'object');
    result.id = String(result.id);

    // convert to boolean
    result.acknowledged = !!result.acknowledged;
}

function add(notification, callback) {
    assert.strictEqual(typeof notification, 'object');
    assert.strictEqual(typeof callback, 'function');

    const query = 'INSERT INTO notifications (userId, eventId, title, message, action) VALUES (?, ?, ?, ?, ?)';
    const args = [ notification.userId, notification.eventId, notification.title, notification.message, notification.action ];

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

    database.query('UPDATE notifications SET ' + fields.join(', ') + ' WHERE id = ?', args, function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        return callback(null);
    });
}

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + NOTIFICATION_FIELDS + ' FROM notifications WHERE id = ?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        postProcess(result[0]);

        callback(null, result[0]);
    });
}

function del(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM notifications WHERE id = ?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function listByUserIdPaged(userId, page, perPage, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof page, 'number');
    assert.strictEqual(typeof perPage, 'number');
    assert.strictEqual(typeof callback, 'function');

    var data = [ userId ];
    var query = 'SELECT ' + NOTIFICATION_FIELDS + ' FROM notifications WHERE userId=?';

    query += ' ORDER BY creationTime DESC LIMIT ?,?';

    data.push((page-1)*perPage);
    data.push(perPage);

    database.query(query, data, function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(postProcess);

        callback(null, results);
    });
}
