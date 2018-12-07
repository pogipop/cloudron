'use strict';

exports = module.exports = {
    addMailbox: addMailbox,
    addGroup: addGroup,

    updateMailboxOwner: updateMailboxOwner,
    updateList: updateList,
    del: del,

    listAliases: listAliases,
    listMailboxes: listMailboxes,
    listGroups: listGroups,

    getMailbox: getMailbox,
    getGroup: getGroup,
    getAlias: getAlias,

    getAliasesForName: getAliasesForName,
    setAliasesForName: setAliasesForName,

    getByOwnerId: getByOwnerId,
    delByOwnerId: delByOwnerId,
    delByDomain: delByDomain,

    updateName: updateName,

    _clear: clear,

    TYPE_MAILBOX: 'mailbox',
    TYPE_LIST: 'list',
    TYPE_ALIAS: 'alias'
};

var assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror.js'),
    safe = require('safetydance'),
    util = require('util');

var MAILBOX_FIELDS = [ 'name', 'type', 'ownerId', 'aliasTarget', 'creationTime', 'membersJson', 'domain' ].join(',');

function postProcess(data) {
    data.members = safe.JSON.parse(data.membersJson) || [ ];
    delete data.membersJson;

    return data;
}

function addMailbox(name, domain, ownerId, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof ownerId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('INSERT INTO mailboxes (name, type, domain, ownerId) VALUES (?, ?, ?, ?)', [ name, exports.TYPE_MAILBOX, domain, ownerId ], function (error) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, 'mailbox already exists'));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function updateMailboxOwner(name, domain, ownerId, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof ownerId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('UPDATE mailboxes SET ownerId = ? WHERE name = ? AND domain = ?', [ ownerId, name, domain ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function addGroup(name, domain, members, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert(Array.isArray(members));
    assert.strictEqual(typeof callback, 'function');

    database.query('INSERT INTO mailboxes (name, type, domain, ownerId, membersJson) VALUES (?, ?, ?, ?, ?)',
        [ name, exports.TYPE_LIST, domain, 'admin', JSON.stringify(members) ], function (error) {
            if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, 'mailbox already exists'));
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            callback(null);
        });
}

function updateList(name, domain, members, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert(Array.isArray(members));
    assert.strictEqual(typeof callback, 'function');

    database.query('UPDATE mailboxes SET membersJson = ? WHERE name = ? AND domain = ?',
        [ JSON.stringify(members), name, domain ], function (error, result) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
            if (result.affectedRows === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

            callback(null);
        });
}

function clear(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('TRUNCATE TABLE mailboxes', [], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        callback(null);
    });
}

function del(name, domain, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    // deletes aliases as well
    database.query('DELETE FROM mailboxes WHERE (name=? OR aliasTarget = ?) AND domain = ?', [ name, name, domain ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function delByDomain(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM mailboxes WHERE domain = ?', [ domain ], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function delByOwnerId(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM mailboxes WHERE ownerId=?', [ id ], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function updateName(oldName, oldDomain, newName, newDomain, callback) {
    assert.strictEqual(typeof oldName, 'string');
    assert.strictEqual(typeof oldDomain, 'string');
    assert.strictEqual(typeof newName, 'string');
    assert.strictEqual(typeof newDomain, 'string');
    assert.strictEqual(typeof callback, 'function');

    // skip if no changes
    if (oldName === newName && oldDomain === newDomain) return callback(null);

    database.query('UPDATE mailboxes SET name=?, domain=? WHERE name=? AND domain = ?', [ newName, newDomain, oldName, oldDomain ], function (error, result) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, 'mailbox already exists'));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function getMailbox(name, domain, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE name = ? AND type = ? AND domain = ?',
        [ name, exports.TYPE_MAILBOX, domain ], function (error, results) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
            if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

            callback(null, postProcess(results[0]));
        });
}

function listMailboxes(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE type = ? AND domain = ? ORDER BY name',
        [ exports.TYPE_MAILBOX, domain ], function (error, results) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            results.forEach(function (result) { postProcess(result); });

            callback(null, results);
        });
}

function listGroups(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE type = ? AND domain = ?',
        [ exports.TYPE_LIST, domain ], function (error, results) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            results.forEach(function (result) { postProcess(result); });

            callback(null, results);
        });
}

function getGroup(name, domain, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE type = ? AND name = ? AND domain = ?',
        [ exports.TYPE_LIST, name, domain ], function (error, results) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
            if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

            callback(null, postProcess(results[0]));
        });
}

function getByOwnerId(ownerId, callback) {
    assert.strictEqual(typeof ownerId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE ownerId = ? ORDER BY name', [ ownerId ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        results.forEach(function (result) { postProcess(result); });

        callback(null, results);
    });
}

function setAliasesForName(name, domain, aliases, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert(util.isArray(aliases));
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE name = ? AND domain = ?', [ name, domain ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        var queries = [];
        // clear existing aliases
        queries.push({ query: 'DELETE FROM mailboxes WHERE aliasTarget = ? AND domain = ? AND type = ?', args: [ name, domain, exports.TYPE_ALIAS ] });
        aliases.forEach(function (alias) {
            queries.push({ query: 'INSERT INTO mailboxes (name, type, domain, aliasTarget, ownerId) VALUES (?, ?, ?, ?, ?)',
                args: [ alias, exports.TYPE_ALIAS, domain, name, results[0].ownerId ] });
        });

        database.transaction(queries, function (error) {
            if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, error.message));
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            callback(null);
        });
    });
}

function getAliasesForName(name, domain, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT name FROM mailboxes WHERE type = ? AND aliasTarget = ? AND domain = ? ORDER BY name',
        [ exports.TYPE_ALIAS, name, domain ], function (error, results) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            results = results.map(function (r) { return r.name; });
            callback(null, results);
        });
}

function listAliases(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE domain = ? AND type = ? ORDER BY name',
        [ domain, exports.TYPE_ALIAS ], function (error, results) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            results.forEach(function (result) { postProcess(result); });

            callback(null, results);
        });
}

function getAlias(name, domain, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE name = ? AND type = ? AND domain = ?',
        [ name, exports.TYPE_ALIAS, domain ], function (error, results) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
            if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

            results.forEach(function (result) { postProcess(result); });

            callback(null, results[0]);
        });
}
