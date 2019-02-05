'use strict';

exports = module.exports = {
    get: get,
    getAllPaged: getAllPaged,
    getByCreationTime: getByCreationTime,
    add: add,
    upsert: upsert,
    count: count,
    delByCreationTime: delByCreationTime,

    _clear: clear
};

var assert = require('assert'),
    async = require('async'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror'),
    mysql = require('mysql'),
    safe = require('safetydance'),
    util = require('util');

var EVENTLOGS_FIELDS = [ 'id', 'action', 'source', 'data', 'creationTime' ].join(',');

function postProcess(eventLog) {
    // usually we have sourceJson and dataJson, however since this used to be the JSON data type, we don't
    eventLog.source = safe.JSON.parse(eventLog.source);
    eventLog.data = safe.JSON.parse(eventLog.data);

    return eventLog;
}

function get(eventId, callback) {
    assert.strictEqual(typeof eventId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + EVENTLOGS_FIELDS + ' FROM eventlog WHERE id = ?', [ eventId ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, postProcess(result[0]));
    });
}

function getAllPaged(actions, search, page, perPage, callback) {
    assert(Array.isArray(actions));
    assert(typeof search === 'string' || search === null);
    assert.strictEqual(typeof page, 'number');
    assert.strictEqual(typeof perPage, 'number');
    assert.strictEqual(typeof callback, 'function');

    var data = [];
    var query = 'SELECT ' + EVENTLOGS_FIELDS + ' FROM eventlog';

    if (actions.length || search) query += ' WHERE';
    if (search) query += ' (source LIKE ' + mysql.escape('%' + search + '%') + ' OR data LIKE ' + mysql.escape('%' + search + '%') + ')';

    if (actions.length && search) query += ' AND ( ';
    actions.forEach(function (action, i) {
        query += ' (action LIKE ' + mysql.escape(`%${action}%`) + ') ';
        if (i < actions.length-1) query += ' OR ';
    });
    if (actions.length && search) query += ' ) ';

    query += ' ORDER BY creationTime DESC LIMIT ?,?';

    data.push((page-1)*perPage);
    data.push(perPage);

    database.query(query, data, function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(postProcess);

        callback(null, results);
    });
}

function getByCreationTime(creationTime, callback) {
    assert(util.isDate(creationTime));
    assert.strictEqual(typeof callback, 'function');

    var query = 'SELECT ' + EVENTLOGS_FIELDS + ' FROM eventlog WHERE creationTime >= ? ORDER BY creationTime DESC';
    database.query(query, [ creationTime ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(postProcess);

        callback(null, results);
    });
}

function add(id, action, source, data, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof action, 'string');
    assert.strictEqual(typeof source, 'object');
    assert.strictEqual(typeof data, 'object');
    assert.strictEqual(typeof callback, 'function');

    database.query('INSERT INTO eventlog (id, action, source, data) VALUES (?, ?, ?, ?)', [ id, action, JSON.stringify(source), JSON.stringify(data) ], function (error, result) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, error));
        if (error || result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null, id);
    });
}

// id is only used if we didn't do an update but insert instead
function upsert(id, action, source, data, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof action, 'string');
    assert.strictEqual(typeof source, 'object');
    assert.strictEqual(typeof data, 'object');
    assert.strictEqual(typeof callback, 'function');

    // can't do a real sql upsert, for frequent eventlog entries we only have to do 2 queries once a day
    var queries = [{
        query: 'UPDATE eventlog SET creationTime=NOW(), data="?" WHERE action = ? AND source LIKE ? AND DATE(creationTime)=CURDATE()',
        args: [ data, action, JSON.stringify(source) ]
    }, {
        query: 'SELECT * FROM eventlog WHERE action = ? AND source LIKE ? AND DATE(creationTime)=CURDATE()',
        args: [ action, JSON.stringify(source) ]
    }];

    database.transaction(queries, function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result[0].affectedRows >= 1) return callback(null, result[1][0].id);

        // no existing eventlog found, create one
        add(id, action, source, data, callback);
    });
}

function count(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT COUNT(*) AS total FROM eventlog', function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        return callback(null, result[0].total);
    });
}

function clear(callback) {
    database.query('DELETE FROM eventlog', function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(error);
    });
}

function delByCreationTime(creationTime, callback) {
    assert(util.isDate(creationTime));
    assert.strictEqual(typeof callback, 'function');

    // since notifications reference eventlog items, we have to clean them up as well
    database.query('SELECT * FROM eventlog WHERE creationTime < ?', [ creationTime ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        async.eachSeries(result, function (item, callback) {
            database.query('DELETE FROM notifications WHERE eventId=?', [ item.id ], function (error) {
                if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

                database.query('DELETE FROM eventlog WHERE id=?', [ item.id ], function (error) {
                    if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
                    callback();
                });
            });
        }, callback);
    });
}
