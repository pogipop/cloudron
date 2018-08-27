'use strict';

exports = module.exports = {
    ClientsError: ClientsError,

    add: add,
    get: get,
    del: del,
    getAll: getAll,
    getByAppIdAndType: getByAppIdAndType,
    getTokensByUserId: getTokensByUserId,
    delTokensByUserId: delTokensByUserId,
    delByAppIdAndType: delByAppIdAndType,
    addTokenByUserId: addTokenByUserId,
    delToken: delToken,

    issueDeveloperToken: issueDeveloperToken,

    addDefaultClients: addDefaultClients,

    // client type enums
    TYPE_EXTERNAL: 'external',
    TYPE_BUILT_IN: 'built-in',
    TYPE_OAUTH: 'addon-oauth',
    TYPE_PROXY: 'addon-proxy'
};

var apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    clientdb = require('./clientdb.js'),
    constants = require('./constants.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:clients'),
    eventlog = require('./eventlog.js'),
    hat = require('./hat.js'),
    accesscontrol = require('./accesscontrol.js'),
    tokendb = require('./tokendb.js'),
    users = require('./users.js'),
    UsersError = users.UsersError,
    util = require('util'),
    uuid = require('uuid');

function ClientsError(reason, errorOrMessage) {
    assert.strictEqual(typeof reason, 'string');
    assert(errorOrMessage instanceof Error || typeof errorOrMessage === 'string' || typeof errorOrMessage === 'undefined');

    Error.call(this);
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name;
    this.reason = reason;
    if (typeof errorOrMessage === 'undefined') {
        this.message = reason;
    } else if (typeof errorOrMessage === 'string') {
        this.message = errorOrMessage;
    } else {
        this.message = 'Internal error';
        this.nestedError = errorOrMessage;
    }
}
util.inherits(ClientsError, Error);
ClientsError.INVALID_SCOPE = 'Invalid scope';
ClientsError.INVALID_CLIENT = 'Invalid client';
ClientsError.INVALID_TOKEN = 'Invalid token';
ClientsError.BAD_FIELD = 'Bad field';
ClientsError.NOT_FOUND = 'Not found';
ClientsError.INTERNAL_ERROR = 'Internal Error';
ClientsError.NOT_ALLOWED = 'Not allowed to remove this client';

function validateClientName(name) {
    assert.strictEqual(typeof name, 'string');

    if (name.length < 1) return new ClientsError(ClientsError.BAD_FIELD, 'Name must be atleast 1 character');
    if (name.length > 128) return new ClientsError(ClientsError.BAD_FIELD, 'Name too long');

    if (/[^a-zA-Z0-9-]/.test(name)) return new ClientsError(ClientsError.BAD_FIELD, 'Username can only contain alphanumerals and dash');

    return null;
}

function add(appId, type, redirectURI, scope, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof redirectURI, 'string');
    assert.strictEqual(typeof scope, 'string');
    assert.strictEqual(typeof callback, 'function');

    var error = accesscontrol.validateScopeString(scope);
    if (error) return callback(new ClientsError(ClientsError.INVALID_SCOPE, error.message));

    error = validateClientName(appId);
    if (error) return callback(error);

    var id = 'cid-' + uuid.v4();
    var clientSecret = hat(8 * 128);

    clientdb.add(id, appId, type, clientSecret, redirectURI, scope, function (error) {
        if (error) return callback(error);

        var client = {
            id: id,
            appId: appId,
            type: type,
            clientSecret: clientSecret,
            redirectURI: redirectURI,
            scope: scope
        };

        callback(null, client);
    });
}

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    clientdb.get(id, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new ClientsError(ClientsError.NOT_FOUND, 'No such client'));
        if (error) return callback(error);
        callback(null, result);
    });
}

function del(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    clientdb.del(id, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new ClientsError(ClientsError.NOT_FOUND, 'No such client'));
        if (error) return callback(error);
        callback(null, result);
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    clientdb.getAll(function (error, results) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, []);
        if (error) return callback(error);

        var tmp = [];
        async.each(results, function (record, callback) {
            if (record.type === exports.TYPE_EXTERNAL || record.type === exports.TYPE_BUILT_IN) {
                // the appId in this case holds the name
                record.name = record.appId;

                tmp.push(record);

                return callback(null);
            }

            apps.get(record.appId, function (error, result) {
                if (error) {
                    console.error('Failed to get app details for oauth client', record.appId, error);
                    return callback(null);  // ignore error so we continue listing clients
                }

                if (record.type === exports.TYPE_PROXY) record.name = result.manifest.title + ' Website Proxy';
                if (record.type === exports.TYPE_OAUTH) record.name = result.manifest.title + ' OAuth';

                record.domain = result.fqdn;

                tmp.push(record);

                callback(null);
            });
        }, function (error) {
            if (error) return callback(error);
            callback(null, tmp);
        });
    });
}

function getByAppIdAndType(appId, type, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    clientdb.getByAppIdAndType(appId, type, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new ClientsError(ClientsError.NOT_FOUND, 'No such client'));
        if (error) return callback(error);
        callback(null, result);
    });
}

function getTokensByUserId(clientId, userId, callback) {
    assert.strictEqual(typeof clientId, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    tokendb.getByIdentifierAndClientId(userId, clientId, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) {
            // this can mean either that there are no tokens or the clientId is actually unknown
            get(clientId, function (error/*, result*/) {
                if (error) return callback(error);
                callback(null, []);
            });
            return;
        }
        if (error) return callback(error);
        callback(null, result || []);
    });
}

function delTokensByUserId(clientId, userId, callback) {
    assert.strictEqual(typeof clientId, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    tokendb.delByIdentifierAndClientId(userId, clientId, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) {
            // this can mean either that there are no tokens or the clientId is actually unknown
            get(clientId, function (error/*, result*/) {
                if (error) return callback(error);
                callback(null);
            });
            return;
        }
        if (error) return callback(error);
        callback(null);
    });
}

function delByAppIdAndType(appId, type, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    getByAppIdAndType(appId, type, function (error, result) {
        if (error) return callback(error);

        tokendb.delByClientId(result.id, function (error) {
            if (error && error.reason !== DatabaseError.NOT_FOUND) return callback(new ClientsError(ClientsError.INTERNAL_ERROR, error));

            clientdb.delByAppIdAndType(appId, type, function (error) {
                if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new ClientsError(ClientsError.NOT_FOUND, 'No such client'));
                if (error) return callback(error);

                callback(null);
            });
        });
    });
}

function addTokenByUserId(clientId, userId, expiresAt, callback) {
    assert.strictEqual(typeof clientId, 'string');
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof expiresAt, 'number');
    assert.strictEqual(typeof callback, 'function');

    get(clientId, function (error, result) {
        if (error) return callback(error);

        users.get(userId, function (error, user) {
            if (error && error.reason === UsersError.NOT_FOUND) return callback(new ClientsError(ClientsError.NOT_FOUND, 'No such user'));
            if (error) return callback(new ClientsError(ClientsError.INTERNAL_ERROR, error));

            accesscontrol.scopesForUser(user, function (error, userScopes) {
                if (error) return callback(new ClientsError(ClientsError.INTERNAL_ERROR, error));

                var scope = accesscontrol.canonicalScopeString(result.scope);
                var authorizedScopes = accesscontrol.intersectScopes(userScopes, scope.split(','));

                var token = tokendb.generateToken();

                tokendb.add(token, userId, result.id, expiresAt, authorizedScopes.join(','), function (error) {
                    if (error) return callback(new ClientsError(ClientsError.INTERNAL_ERROR, error));

                    callback(null, {
                        accessToken: token,
                        tokenScopes: authorizedScopes,
                        identifier: userId,
                        clientId: result.id,
                        expires: expiresAt
                    });
                });
            });
        });
    });
}

// this issues a cid-cli token that does not require a password in various routes
function issueDeveloperToken(userObject, ip, callback) {
    assert.strictEqual(typeof userObject, 'object');
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    const expiresAt = Date.now() + constants.DEFAULT_TOKEN_EXPIRATION;

    addTokenByUserId('cid-cli', userObject.id, expiresAt, function (error, result) {
        if (error) return callback(error);

        eventlog.add(eventlog.ACTION_USER_LOGIN, { authType: 'cli', ip: ip }, { userId: userObject.id, user: users.removePrivateFields(userObject) });

        callback(null, result);
    });
}

function delToken(clientId, tokenId, callback) {
    assert.strictEqual(typeof clientId, 'string');
    assert.strictEqual(typeof tokenId, 'string');
    assert.strictEqual(typeof callback, 'function');

    get(clientId, function (error) {
        if (error) return callback(error);

        tokendb.del(tokenId, function (error) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new ClientsError(ClientsError.INVALID_TOKEN, 'Invalid token'));
            if (error) return callback(new ClientsError(ClientsError.INTERNAL_ERROR, error));

            callback(null);
        });
    });
}

function addDefaultClients(origin, callback) {
    assert.strictEqual(typeof origin, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('Adding default clients');

    // The domain might have changed, therefor we have to update the record
    // id, appId, type, clientSecret, redirectURI, scope
    async.series([
        clientdb.upsert.bind(null, 'cid-webadmin', 'Settings', 'built-in', 'secret-webadmin', origin, '*'),
        clientdb.upsert.bind(null, 'cid-sdk', 'SDK', 'built-in', 'secret-sdk', origin, '*'),
        clientdb.upsert.bind(null, 'cid-cli', 'Cloudron Tool', 'built-in', 'secret-cli', origin, '*')
    ], callback);
}
