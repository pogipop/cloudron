'use strict';

var assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror.js'),
    safe = require('safetydance'),
    util = require('util');

var BACKUPS_FIELDS = [ 'id', 'creationTime', 'version', 'type', 'dependsOn', 'state', 'restoreConfigJson', 'format' ];

exports = module.exports = {
    add: add,

    getByTypeAndStatePaged: getByTypeAndStatePaged,
    getByTypePaged: getByTypePaged,

    get: get,
    del: del,
    update: update,
    getByAppIdPaged: getByAppIdPaged,

    _clear: clear,

    BACKUP_TYPE_APP: 'app',
    BACKUP_TYPE_BOX: 'box',

    BACKUP_STATE_NORMAL: 'normal', // should rename to created to avoid listing in UI?
    BACKUP_STATE_CREATING: 'creating',
    BACKUP_STATE_ERROR: 'error'
};

function postProcess(result) {
    assert.strictEqual(typeof result, 'object');

    result.dependsOn = result.dependsOn ? result.dependsOn.split(',') : [ ];

    result.restoreConfig = result.restoreConfigJson ? safe.JSON.parse(result.restoreConfigJson) : null;
    delete result.restoreConfigJson;
}

function getByTypeAndStatePaged(type, state, page, perPage, callback) {
    assert(type === exports.BACKUP_TYPE_APP || type === exports.BACKUP_TYPE_BOX);
    assert.strictEqual(typeof state, 'string');
    assert(typeof page === 'number' && page > 0);
    assert(typeof perPage === 'number' && perPage > 0);
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + BACKUPS_FIELDS + ' FROM backups WHERE type = ? AND state = ? ORDER BY creationTime DESC LIMIT ?,?',
        [ type, state, (page-1)*perPage, perPage ], function (error, results) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            results.forEach(function (result) { postProcess(result); });

            callback(null, results);
        });
}

function getByTypePaged(type, page, perPage, callback) {
    assert(type === exports.BACKUP_TYPE_APP || type === exports.BACKUP_TYPE_BOX);
    assert(typeof page === 'number' && page > 0);
    assert(typeof perPage === 'number' && perPage > 0);
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + BACKUPS_FIELDS + ' FROM backups WHERE type = ? ORDER BY creationTime DESC LIMIT ?,?',
        [ type, (page-1)*perPage, perPage ], function (error, results) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            results.forEach(function (result) { postProcess(result); });

            callback(null, results);
        });
}

function getByAppIdPaged(page, perPage, appId, callback) {
    assert(typeof page === 'number' && page > 0);
    assert(typeof perPage === 'number' && perPage > 0);
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    // box versions (0.93.x and below) used to use appbackup_ prefix
    database.query('SELECT ' + BACKUPS_FIELDS + ' FROM backups WHERE type = ? AND state = ? AND id LIKE ? ORDER BY creationTime DESC LIMIT ?,?',
        [ exports.BACKUP_TYPE_APP, exports.BACKUP_STATE_NORMAL, '%app%\\_' + appId + '\\_%', (page-1)*perPage, perPage ], function (error, results) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            results.forEach(function (result) { postProcess(result); });

            callback(null, results);
        });
}

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + BACKUPS_FIELDS + ' FROM backups WHERE id = ? ORDER BY creationTime DESC',
        [ id ], function (error, result) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
            if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

            postProcess(result[0]);

            callback(null, result[0]);
        });
}

function add(backup, callback) {
    assert(backup && typeof backup === 'object');
    assert.strictEqual(typeof backup.id, 'string');
    assert.strictEqual(typeof backup.version, 'string');
    assert(backup.type === exports.BACKUP_TYPE_APP || backup.type === exports.BACKUP_TYPE_BOX);
    assert(util.isArray(backup.dependsOn));
    assert.strictEqual(typeof backup.restoreConfig, 'object');
    assert.strictEqual(typeof backup.format, 'string');
    assert.strictEqual(typeof callback, 'function');

    var creationTime = backup.creationTime || new Date(); // allow tests to set the time
    var restoreConfig = backup.restoreConfig ? JSON.stringify(backup.restoreConfig) : '';

    database.query('INSERT INTO backups (id, version, type, creationTime, state, dependsOn, restoreConfigJson, format) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [ backup.id, backup.version, backup.type, creationTime, exports.BACKUP_STATE_NORMAL, backup.dependsOn.join(','), restoreConfig, backup.format ],
        function (error) {
            if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS));
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            callback(null);
        });
}

function update(id, backup, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof backup, 'object');
    assert.strictEqual(typeof callback, 'function');

    var fields = [ ], values = [ ];
    for (var p in backup) {
        fields.push(p + ' = ?');
        values.push(backup[p]);
    }
    values.push(id);

    database.query('UPDATE backups SET ' + fields.join(', ') + ' WHERE id = ?', values, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new DatabaseError(DatabaseError.NOT_FOUND));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function clear(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('TRUNCATE TABLE backups', [], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        callback(null);
    });
}

function del(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM backups WHERE id=?', [ id ], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        callback(null);
    });
}
