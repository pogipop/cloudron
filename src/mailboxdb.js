'use strict';

exports = module.exports = {
    addMailbox: addMailbox,
    addGroup: addGroup,

    updateMailbox: updateMailbox,
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

    OWNER_TYPE_USER: 'user',
    OWNER_TYPE_APP: 'app',
    OWNER_TYPE_GROUP: 'group'
};

var assert = require('assert'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror.js'),
    safe = require('safetydance'),
    util = require('util');

var MAILBOX_FIELDS = [ 'name', 'ownerId', 'ownerType', 'aliasTarget', 'creationTime', 'membersJson', 'domain' ].join(',');

function postProcess(data) {
    data.members = safe.JSON.parse(data.membersJson) || [ ];
    delete data.membersJson;

    return data;
}

function addMailbox(name, domain, ownerId, ownerType, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof ownerId, 'string');
    assert.strictEqual(typeof ownerType, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('INSERT INTO mailboxes (name, domain, ownerId, ownerType) VALUES (?, ?, ?, ?)', [ name, domain, ownerId, ownerType ], function (error) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, 'mailbox already exists'));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function updateMailbox(name, domain, ownerId, ownerType, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof ownerId, 'string');
    assert.strictEqual(typeof ownerType, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('UPDATE mailboxes SET ownerId = ? WHERE name = ? AND domain = ? AND ownerType = ?', [ ownerId, name, domain, ownerType ], function (error, result) {
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

    database.query('INSERT INTO mailboxes (name, domain, ownerId, ownerType, membersJson) VALUES (?, ?, ?, ?, ?)',
        [ name, domain, 'admin', exports.OWNER_TYPE_GROUP, JSON.stringify(members) ], function (error) {
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

    // deletes aliases as well
    database.query('DELETE FROM mailboxes WHERE domain = ?', [ domain ], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function delByOwnerId(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    // deletes aliases as well
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

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE name = ? AND domain = ? AND (ownerType = ? OR ownerType = ?) AND aliasTarget IS NULL', [ name, domain, exports.OWNER_TYPE_APP, exports.OWNER_TYPE_USER ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, postProcess(results[0]));
    });
}

function listMailboxes(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE domain = ? AND (ownerType = ? OR ownerType = ?) AND aliasTarget IS NULL ORDER BY name', [ domain, exports.OWNER_TYPE_APP, exports.OWNER_TYPE_USER ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(function (result) { postProcess(result); });

        callback(null, results);
    });
}

function listGroups(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE domain = ? AND ownerType = ? AND aliasTarget IS NULL',[ domain, exports.OWNER_TYPE_GROUP ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(function (result) { postProcess(result); });

        callback(null, results);
    });
}

function getGroup(name, domain, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE name = ? AND domain = ? AND ownerType = ? AND aliasTarget IS NULL', [ name, domain, exports.OWNER_TYPE_GROUP ], function (error, results) {
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
        queries.push({ query: 'DELETE FROM mailboxes WHERE aliasTarget = ? AND domain = ?', args: [ name, domain ] });
        aliases.forEach(function (alias) {
            queries.push({ query: 'INSERT INTO mailboxes (name, domain, aliasTarget, ownerId, ownerType) VALUES (?, ?, ?, ?, ?)',
                args: [ alias, domain, name, results[0].ownerId, results[0].ownerType ] });
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

    database.query('SELECT name FROM mailboxes WHERE aliasTarget = ? AND domain = ? ORDER BY name', [ name, domain ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results = results.map(function (r) { return r.name; });
        callback(null, results);
    });
}

function listAliases(domain, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE domain = ? AND aliasTarget IS NOT NULL ORDER BY name', [ domain ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(function (result) { postProcess(result); });

        callback(null, results);
    });
}

function getAlias(name, domain, callback) {
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + MAILBOX_FIELDS + ' FROM mailboxes WHERE name = ? AND domain = ? AND aliasTarget IS NOT NULL', [ name, domain ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        results.forEach(function (result) { postProcess(result); });

        callback(null, results[0]);
    });
}
