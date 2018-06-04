'use strict';

exports = module.exports = {
    UsersError: UsersError,

    removePrivateFields: removePrivateFields,

    list: listUsers,
    create: createUser,
    count: count,
    verify: verify,
    verifyWithUsername: verifyWithUsername,
    verifyWithEmail: verifyWithEmail,
    remove: removeUser,
    get: getUser,
    getByResetToken: getByResetToken,
    getAllAdmins: getAllAdmins,
    resetPasswordByIdentifier: resetPasswordByIdentifier,
    setPassword: setPassword,
    update: updateUser,
    createOwner: createOwner,
    getOwner: getOwner,
    sendInvite: sendInvite,
    setGroups: setGroups,
    setTwoFactorAuthenticationSecret: setTwoFactorAuthenticationSecret,
    enableTwoFactorAuthentication: enableTwoFactorAuthentication,
    disableTwoFactorAuthentication: disableTwoFactorAuthentication
};

var assert = require('assert'),
    crypto = require('crypto'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    debug = require('debug')('box:user'),
    DatabaseError = require('./databaseerror.js'),
    eventlog = require('./eventlog.js'),
    groupdb = require('./groupdb.js'),
    groups = require('./groups.js'),
    GroupsError = groups.GroupsError,
    hat = require('hat'),
    mailer = require('./mailer.js'),
    qrcode = require('qrcode'),
    safe = require('safetydance'),
    speakeasy = require('speakeasy'),
    userdb = require('./userdb.js'),
    util = require('util'),
    uuid = require('uuid'),
    validatePassword = require('./password.js').validate,
    validator = require('validator'),
    _ = require('underscore');

var CRYPTO_SALT_SIZE = 64; // 512-bit salt
var CRYPTO_ITERATIONS = 10000; // iterations
var CRYPTO_KEY_LENGTH = 512; // bits
var CRYPTO_DIGEST = 'sha1'; // used to be the default in node 4.1.1 cannot change since it will affect existing db records

// http://dustinsenos.com/articles/customErrorsInNode
// http://code.google.com/p/v8/wiki/JavaScriptStackTraceApi
function UsersError(reason, errorOrMessage) {
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
util.inherits(UsersError, Error);
UsersError.INTERNAL_ERROR = 'Internal Error';
UsersError.ALREADY_EXISTS = 'Already Exists';
UsersError.NOT_FOUND = 'Not Found';
UsersError.WRONG_PASSWORD = 'Wrong User or Password';
UsersError.BAD_FIELD = 'Bad field';
UsersError.BAD_TOKEN = 'Bad token';

// keep this in sync with validateGroupname and validateAlias
function validateUsername(username) {
    assert.strictEqual(typeof username, 'string');

    if (username.length < 1) return new UsersError(UsersError.BAD_FIELD, 'Username must be atleast 1 char');
    if (username.length >= 200) return new UsersError(UsersError.BAD_FIELD, 'Username too long');

    if (constants.RESERVED_NAMES.indexOf(username) !== -1) return new UsersError(UsersError.BAD_FIELD, 'Username is reserved');

    // also need to consider valid LDAP characters here (e.g '+' is reserved)
    if (/[^a-zA-Z0-9.-]/.test(username)) return new UsersError(UsersError.BAD_FIELD, 'Username can only contain alphanumerals, dot and -');

    // app emails are sent using the .app suffix
    if (username.indexOf('.app') !== -1) return new UsersError(UsersError.BAD_FIELD, 'Username pattern is reserved for apps');

    return null;
}

function validateEmail(email) {
    assert.strictEqual(typeof email, 'string');

    if (!validator.isEmail(email)) return new UsersError(UsersError.BAD_FIELD, 'Invalid email');

    return null;
}

function validateToken(token) {
    assert.strictEqual(typeof token, 'string');

    if (token.length !== 64) return new UsersError(UsersError.BAD_TOKEN, 'Invalid token'); // 256-bit hex coded token

    return null;
}

function validateDisplayName(name) {
    assert.strictEqual(typeof name, 'string');

    return null;
}

function removePrivateFields(user) {
    return _.pick(user, 'id', 'username', 'email', 'fallbackEmail', 'displayName', 'groupIds', 'admin');
}

function createUser(username, password, email, displayName, auditSource, options, callback) {
    assert(username === null || typeof username === 'string');
    assert.strictEqual(typeof password, 'string');
    assert.strictEqual(typeof email, 'string');
    assert.strictEqual(typeof displayName, 'string');
    assert.strictEqual(typeof auditSource, 'object');

    if (typeof options === 'function') {
        callback = options;
        options = null;
    }

    var invitor = options && options.invitor ? options.invitor : null,
        sendInvite = options && options.sendInvite ? true : false,
        owner = options && options.owner ? true : false;

    var error;

    if (username !== null) {
        username = username.toLowerCase();
        error = validateUsername(username);
        if (error) return callback(error);
    }

    error = validatePassword(password);
    if (error) return callback(new UsersError(UsersError.BAD_FIELD, error.message));

    email = email.toLowerCase();
    error = validateEmail(email);
    if (error) return callback(error);

    error = validateDisplayName(displayName);
    if (error) return callback(error);

    crypto.randomBytes(CRYPTO_SALT_SIZE, function (error, salt) {
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        crypto.pbkdf2(password, salt, CRYPTO_ITERATIONS, CRYPTO_KEY_LENGTH, CRYPTO_DIGEST, function (error, derivedKey) {
            if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            var now = (new Date()).toISOString();
            var user = {
                id: 'uid-' + uuid.v4(),
                username: username,
                email: email,
                fallbackEmail: email,   // for new users the fallbackEmail is also the default email
                password: new Buffer(derivedKey, 'binary').toString('hex'),
                salt: salt.toString('hex'),
                createdAt: now,
                modifiedAt: now,
                resetToken: hat(256),
                displayName: displayName
            };

            userdb.add(user.id, user, function (error) {
                if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new UsersError(UsersError.ALREADY_EXISTS, error.message));
                if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

                callback(null, user);

                eventlog.add(eventlog.ACTION_USER_ADD, auditSource, { userId: user.id, email: user.email, user: removePrivateFields(user) });

                if (!owner) mailer.userAdded(user, sendInvite);
                if (sendInvite) mailer.sendInvite(user, invitor);
            });
        });
    });
}

// returns true if ghost user was matched
function verifyGhost(username, password) {
    assert.strictEqual(typeof username, 'string');
    assert.strictEqual(typeof password, 'string');

    var ghostData = safe.JSON.parse(safe.fs.readFileSync(constants.GHOST_USER_FILE, 'utf8'));
    if (!ghostData) return false;

    if (username in ghostData && ghostData[username] === password) {
        debug('verifyGhost: matched ghost user');
        return true;
    }

    return false;
}

function verify(userId, password, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof password, 'string');
    assert.strictEqual(typeof callback, 'function');

    getUser(userId, function (error, user) {
        if (error) return callback(error);

        // for just invited users the username may be still null
        if (user.username && verifyGhost(user.username, password)) {
            user.ghost = true;
            return callback(null, user);
        }

        var saltBinary = new Buffer(user.salt, 'hex');
        crypto.pbkdf2(password, saltBinary, CRYPTO_ITERATIONS, CRYPTO_KEY_LENGTH, CRYPTO_DIGEST, function (error, derivedKey) {
            if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            var derivedKeyHex = new Buffer(derivedKey, 'binary').toString('hex');
            if (derivedKeyHex !== user.password) return callback(new UsersError(UsersError.WRONG_PASSWORD));

            callback(null, user);
        });
    });
}

function verifyWithUsername(username, password, callback) {
    assert.strictEqual(typeof username, 'string');
    assert.strictEqual(typeof password, 'string');
    assert.strictEqual(typeof callback, 'function');

    userdb.getByUsername(username.toLowerCase(), function (error, user) {
        if (error && error.reason == DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        verify(user.id, password, callback);
    });
}

function verifyWithEmail(email, password, callback) {
    assert.strictEqual(typeof email, 'string');
    assert.strictEqual(typeof password, 'string');
    assert.strictEqual(typeof callback, 'function');

    userdb.getByEmail(email.toLowerCase(), function (error, user) {
        if (error && error.reason == DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        verify(user.id, password, callback);
    });
}

function removeUser(userId, auditSource, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    getUser(userId, function (error, user) {
        if (error) return callback(error);

        if (config.isDemo() && user.username === constants.DEMO_USERNAME) return callback(new UsersError(UsersError.BAD_FIELD, 'Not allowed in demo mode'));

        userdb.del(userId, function (error) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
            if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            eventlog.add(eventlog.ACTION_USER_REMOVE, auditSource, { userId: userId, user: removePrivateFields(user) });

            callback();

            mailer.userRemoved(user);
        });
    });
}

function listUsers(callback) {
    assert.strictEqual(typeof callback, 'function');

    userdb.getAllWithGroupIds(function (error, results) {
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        results.forEach(function (result) {
            result.admin = result.groupIds.indexOf(constants.ADMIN_GROUP_ID) !== -1;
        });

        return callback(null, results);
    });
}

function count(callback) {
    assert.strictEqual(typeof callback, 'function');

    userdb.count(function (error, count) {
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        callback(null, count);
    });
}

function getUser(userId, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    userdb.get(userId, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        groups.getGroups(userId, function (error, groupIds) {
            if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            result.groupIds = groupIds;
            result.admin = groupIds.indexOf(constants.ADMIN_GROUP_ID) !== -1;
            result.scope = result.admin ? '*' : 'profile';

            return callback(null, result);
        });
    });
}

function getByResetToken(resetToken, callback) {
    assert.strictEqual(typeof resetToken, 'string');
    assert.strictEqual(typeof callback, 'function');

    var error = validateToken(resetToken);
    if (error) return callback(error);

    userdb.getByResetToken(resetToken, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        getUser(result.id, callback);
    });
}

function updateUser(userId, data, auditSource, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof data, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    var error;
    data = _.pick(data, 'email', 'fallbackEmail', 'displayName', 'username');

    if (_.isEmpty(data)) return callback();

    if (data.username) {
        data.username = data.username.toLowerCase();
        error = validateUsername(data.username);
        if (error) return callback(error);
    }

    if (data.email) {
        data.email = data.email.toLowerCase();
        error = validateEmail(data.email);
        if (error) return callback(error);
    }

    if (data.fallbackEmail) {
        data.fallbackEmail = data.fallbackEmail.toLowerCase();
        error = validateEmail(data.fallbackEmail);
        if (error) return callback(error);
    }

    userdb.get(userId, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        userdb.update(userId, data, function (error) {
            if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new UsersError(UsersError.ALREADY_EXISTS, error.message));
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND, error));
            if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            callback();

            getUser(userId, function (error, result) {
                if (error) return console.error(error);

                eventlog.add(eventlog.ACTION_USER_UPDATE, auditSource, { userId: userId, user: removePrivateFields(result) });
            });
        });
    });
}

function setGroups(userId, groupIds, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert(Array.isArray(groupIds));
    assert.strictEqual(typeof callback, 'function');

    groups.getGroups(userId, function (error, oldGroupIds) {
        if (error && error.reason !== GroupsError.NOT_FOUND) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        oldGroupIds = oldGroupIds || [];

        groups.setGroups(userId, groupIds, function (error) {
            if (error && error.reason === GroupsError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND, 'One or more groups not found'));
            if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            var isAdmin = groupIds.some(function (g) { return g === constants.ADMIN_GROUP_ID; });
            var wasAdmin = oldGroupIds.some(function (g) { return g === constants.ADMIN_GROUP_ID; });

            if ((isAdmin && !wasAdmin) || (!isAdmin && wasAdmin)) {
                getUser(userId, function (error, result) {
                    if (error) return debug('Failed to send admin change mail.', error);

                    mailer.adminChanged(result, isAdmin);
                });
            }

            callback(null);
        });
    });
}

function getAllAdmins(callback) {
    assert.strictEqual(typeof callback, 'function');

    userdb.getAllAdmins(function (error, admins) {
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        callback(null, admins);
    });
}

function resetPasswordByIdentifier(identifier, callback) {
    assert.strictEqual(typeof identifier, 'string');
    assert.strictEqual(typeof callback, 'function');

    var getter;
    if (identifier.indexOf('@') === -1) getter = userdb.getByUsername;
    else getter = userdb.getByEmail;

    getter(identifier.toLowerCase(), function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        result.resetToken = hat(256);

        userdb.update(result.id, result, function (error) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
            if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            mailer.passwordReset(result);

            callback(null);
        });
    });
}

function setPassword(userId, newPassword, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof newPassword, 'string');
    assert.strictEqual(typeof callback, 'function');

    var error = validatePassword(newPassword);
    if (error) return callback(new UsersError(UsersError.BAD_FIELD, error.message));

    userdb.get(userId, function (error, user) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        if (config.isDemo() && user.username === constants.DEMO_USERNAME) return callback(new UsersError(UsersError.BAD_FIELD, 'Not allowed in demo mode'));

        var saltBuffer = new Buffer(user.salt, 'hex');
        crypto.pbkdf2(newPassword, saltBuffer, CRYPTO_ITERATIONS, CRYPTO_KEY_LENGTH, CRYPTO_DIGEST, function (error, derivedKey) {
            if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            user.modifiedAt = (new Date()).toISOString();
            user.password = new Buffer(derivedKey, 'binary').toString('hex');
            user.resetToken = '';

            userdb.update(userId, user, function (error) {
                if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
                if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

                callback();
            });
        });
    });
}

function createOwner(username, password, email, displayName, auditSource, callback) {
    assert.strictEqual(typeof username, 'string');
    assert.strictEqual(typeof password, 'string');
    assert.strictEqual(typeof email, 'string');
    assert.strictEqual(typeof displayName, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    // This is only not allowed for the owner
    if (username === '') return callback(new UsersError(UsersError.BAD_FIELD, 'Username cannot be empty'));

    userdb.count(function (error, count) {
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));
        if (count !== 0) return callback(new UsersError(UsersError.ALREADY_EXISTS, 'Owner already exists'));

        // have to provide the group id explicitly so using db layer directly
        groupdb.add(constants.ADMIN_GROUP_ID, constants.ADMIN_GROUP_NAME, function (error) {
            // we proceed if it already exists so we can re-create the owner if need be
            if (error && error.reason !== DatabaseError.ALREADY_EXISTS) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            createUser(username, password, email, displayName, auditSource, { owner: true }, function (error, user) {
                if (error) return callback(error);

                groups.addMember(constants.ADMIN_GROUP_ID, user.id, function (error) {
                    if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

                    callback(null, user);
                });
            });
        });
    });
}

function getOwner(callback) {
    userdb.getOwner(function (error, owner) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        return callback(null, owner);
    });
}

function sendInvite(userId, options, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    userdb.get(userId, function (error, userObject) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        userObject.resetToken = hat(256);

        userdb.update(userId, userObject, function (error) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
            if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            mailer.sendInvite(userObject, options.invitor || null);

            callback(null, userObject.resetToken);
        });
    });
}

function setTwoFactorAuthenticationSecret(userId, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    userdb.get(userId, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        if (result.twoFactorAuthenticationEnabled) return callback(new UsersError(UsersError.ALREADY_EXISTS));

        var secret = speakeasy.generateSecret({ name: `Cloudron ${config.adminFqdn()} (${result.username})` });

        userdb.update(userId, { twoFactorAuthenticationSecret: secret.base32, twoFactorAuthenticationEnabled: false }, function (error) {
            if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            qrcode.toDataURL(secret.otpauth_url, function (error, dataUrl) {
                if (error) console.error(error);

                callback(null, { secret: secret.base32, qrcode: dataUrl });
            });
        });
    });
}

function enableTwoFactorAuthentication(userId, totpToken, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof totpToken, 'string');
    assert.strictEqual(typeof callback, 'function');

    userdb.get(userId, function (error, result) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new UsersError(UsersError.NOT_FOUND));
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        var verified = speakeasy.totp.verify({ secret: result.twoFactorAuthenticationSecret, encoding: 'base32', token: totpToken });
        if (!verified) return callback(new UsersError(UsersError.BAD_TOKEN));

        if (result.twoFactorAuthenticationEnabled) return callback(new UsersError(UsersError.ALREADY_EXISTS));

        userdb.update(userId, { twoFactorAuthenticationEnabled: true }, function (error) {
            if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

            callback(null);
        });
    });
}

function disableTwoFactorAuthentication(userId, callback) {
    assert.strictEqual(typeof userId, 'string');
    assert.strictEqual(typeof callback, 'function');

    userdb.update(userId, { twoFactorAuthenticationEnabled: false, twoFactorAuthenticationSecret: '' }, function (error) {
        if (error) return callback(new UsersError(UsersError.INTERNAL_ERROR, error));

        callback(null);
    });
}
