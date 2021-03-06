'use strict';

exports = module.exports = {
    get: get,
    getByUsername: getByUsername,
    getByEmail: getByEmail,
    getByAccessToken: getByAccessToken,
    getByResetToken: getByResetToken,
    getOwner: getOwner,
    getAllWithGroupIds: getAllWithGroupIds,
    getAllWithGroupIdsPaged: getAllWithGroupIdsPaged,
    getAllAdmins: getAllAdmins,
    add: add,
    del: del,
    update: update,
    count: count,

    _clear: clear
};

var assert = require('assert'),
    database = require('./database.js'),
    debug = require('debug')('box:userdb'),
    DatabaseError = require('./databaseerror'),
    mysql = require('mysql');

var USERS_FIELDS = [ 'id', 'username', 'email', 'fallbackEmail', 'password', 'salt', 'createdAt', 'modifiedAt', 'resetToken', 'displayName',
    'twoFactorAuthenticationEnabled', 'twoFactorAuthenticationSecret', 'admin' ].join(',');

function postProcess(result) {
    assert.strictEqual(typeof result, 'object');

    result.twoFactorAuthenticationEnabled = !!result.twoFactorAuthenticationEnabled;
    result.admin = !!result.admin;

    return result;
}

function get(userId, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + USERS_FIELDS + ' FROM users WHERE id = ?', [ userId ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, postProcess(result[0]));
    });
}

function getByUsername(username, callback) {
    assert.strictEqual(typeof username, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + USERS_FIELDS + ' FROM users WHERE username = ?', [ username ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, postProcess(result[0]));
    });
}

function getByEmail(email, callback) {
    assert.strictEqual(typeof email, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + USERS_FIELDS + ' FROM users WHERE email = ?', [ email ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, postProcess(result[0]));
    });
}

function getOwner(callback) {
    assert.strictEqual(typeof callback, 'function');

    // the first created user it the 'owner'
    database.query('SELECT ' + USERS_FIELDS + ' FROM users WHERE admin=1 ORDER BY createdAt LIMIT 1', function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, postProcess(result[0]));
    });
}

function getByResetToken(email, resetToken, callback) {
    assert.strictEqual(typeof email, 'string');
    assert.strictEqual(typeof resetToken, 'string');
    assert.strictEqual(typeof callback, 'function');

    if (resetToken.length === 0) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, 'Empty resetToken not allowed'));

    database.query('SELECT ' + USERS_FIELDS + ' FROM users WHERE email=? AND resetToken=?', [ email, resetToken ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, postProcess(result[0]));
    });
}

function getAllWithGroupIds(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + USERS_FIELDS + ',GROUP_CONCAT(groupMembers.groupId) AS groupIds ' +
                    ' FROM users LEFT OUTER JOIN groupMembers ON users.id = groupMembers.userId ' +
                    ' GROUP BY users.id ORDER BY users.username', function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(function (result) {
            result.groupIds = result.groupIds ? result.groupIds.split(',') : [ ];
        });

        results.forEach(postProcess);

        callback(null, results);
    });
}

function getAllWithGroupIdsPaged(search, page, perPage, callback) {
    assert(typeof search === 'string' || search === null);
    assert.strictEqual(typeof page, 'number');
    assert.strictEqual(typeof perPage, 'number');
    assert.strictEqual(typeof callback, 'function');

    var query = `SELECT ${USERS_FIELDS},GROUP_CONCAT(groupMembers.groupId) AS groupIds FROM users LEFT OUTER JOIN groupMembers ON users.id = groupMembers.userId `;

    if (search) query += ' WHERE (users.username LIKE ' + mysql.escape(`%${search}%`) + ') ';

    query += ` GROUP BY users.id ORDER BY users.username ASC LIMIT ${(page-1)*perPage},${perPage} `;

    database.query(query, function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(function (result) {
            result.groupIds = result.groupIds ? result.groupIds.split(',') : [ ];
        });

        results.forEach(postProcess);

        callback(null, results);
    });
}

function getAllAdmins(callback) {
    assert.strictEqual(typeof callback, 'function');

    // the mailer code relies on the first object being the 'owner' (thus the ORDER)
    database.query('SELECT ' + USERS_FIELDS + ' FROM users WHERE admin=1 ORDER BY createdAt', function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(postProcess);

        callback(null, results);
    });
}

function add(userId, user, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert(user.username === null || typeof user.username === 'string');
    assert.strictEqual(typeof user.password, 'string');
    assert.strictEqual(typeof user.email, 'string');
    assert.strictEqual(typeof user.fallbackEmail, 'string');
    assert.strictEqual(typeof user.salt, 'string');
    assert.strictEqual(typeof user.createdAt, 'string');
    assert.strictEqual(typeof user.modifiedAt, 'string');
    assert.strictEqual(typeof user.resetToken, 'string');
    assert.strictEqual(typeof user.displayName, 'string');
    assert.strictEqual(typeof user.admin, 'boolean');
    assert.strictEqual(typeof callback, 'function');

    const query = 'INSERT INTO users (id, username, password, email, fallbackEmail, salt, createdAt, modifiedAt, resetToken, displayName, admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    const args = [ userId, user.username, user.password, user.email, user.fallbackEmail, user.salt, user.createdAt, user.modifiedAt, user.resetToken, user.displayName, user.admin ];

    database.query(query, args, function (error) {
        if (error && error.code === 'ER_DUP_ENTRY' && error.sqlMessage.indexOf('users_email') !== -1) return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, 'email already exists'));
        if (error && error.code === 'ER_DUP_ENTRY' && error.sqlMessage.indexOf('users_username') !== -1) return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, 'username already exists'));
        if (error && error.code === 'ER_DUP_ENTRY' && error.sqlMessage.indexOf('PRIMARY') !== -1) return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, 'id already exists'));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function del(userId, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    // also cleanup the groupMembers table
    var queries = [];
    queries.push({ query: 'DELETE FROM groupMembers WHERE userId = ?', args: [ userId ] });
    queries.push({ query: 'DELETE FROM tokens WHERE identifier = ?', args: [ userId ] });
    queries.push({ query: 'DELETE FROM users WHERE id = ?', args: [ userId ] });

    database.transaction(queries, function (error, result) {
        if (error && error.code === 'ER_NO_REFERENCED_ROW_2') return callback(new DatabaseError(DatabaseError.NOT_FOUND, error));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result[2].affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(error);
    });
}

function getByAccessToken(accessToken, callback) {
    assert.strictEqual(typeof accessToken, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('getByAccessToken: ' +  accessToken);

    database.query('SELECT ' + USERS_FIELDS + ' FROM users, tokens WHERE tokens.accessToken = ?', [ accessToken ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, postProcess(result[0]));
    });
}

function clear(callback) {
    database.query('DELETE FROM users', function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(error);
    });
}

function update(userId, user, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof callback, 'function');

    var args = [ ];
    var fields = [ ];
    for (var k in user) {
        fields.push(k + ' = ?');

        if (k === 'username') {
            assert(user.username === null || typeof user.username === 'string');
            args.push(user.username);
        } else if (k === 'email' || k === 'fallbackEmail') {
            assert.strictEqual(typeof user[k], 'string');
            args.push(user[k]);
        } else if (k === 'twoFactorAuthenticationEnabled' || k === 'admin') {
            assert.strictEqual(typeof user[k], 'boolean');
            args.push(user[k] ? 1 : 0);
        } else {
            args.push(user[k]);
        }
    }
    args.push(userId);

    database.query('UPDATE users SET ' + fields.join(', ') + ' WHERE id = ?', args, function (error) {
        if (error && error.code === 'ER_DUP_ENTRY' && error.sqlMessage.indexOf('users_email') !== -1) return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, 'email already exists'));
        if (error && error.code === 'ER_DUP_ENTRY' && error.sqlMessage.indexOf('users_username') !== -1) return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, 'username already exists'));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function count(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT COUNT(*) AS total FROM users', function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        return callback(null, result[0].total);
    });
}
