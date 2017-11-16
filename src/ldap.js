'use strict';

exports = module.exports = {
    start: start,
    stop: stop
};

var assert = require('assert'),
    appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    async = require('async'),
    config = require('./config.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:ldap'),
    eventlog = require('./eventlog.js'),
    user = require('./user.js'),
    UserError = user.UserError,
    ldap = require('ldapjs'),
    mailboxdb = require('./mailboxdb.js'),
    safe = require('safetydance');

var gServer = null;

var NOOP = function () {};

var GROUP_USERS_DN = 'cn=users,ou=groups,dc=cloudron';
var GROUP_ADMINS_DN = 'cn=admins,ou=groups,dc=cloudron';

function getAppByRequest(req, callback) {
    assert.strictEqual(typeof req, 'object');
    assert.strictEqual(typeof callback, 'function');

    var sourceIp = req.connection.ldap.id.split(':')[0];
    if (sourceIp.split('.').length !== 4) return callback(new ldap.InsufficientAccessRightsError('Missing source identifier'));

    apps.getByIpAddress(sourceIp, function (error, app) {
        if (error) return callback(new ldap.OperationsError(error.message));

        if (!app) return callback(new ldap.OperationsError('Could not detect app source'));

        callback(null, app);
    });
}

function getUsersWithAccessToApp(req, callback) {
    assert.strictEqual(typeof req, 'object');
    assert.strictEqual(typeof callback, 'function');

    getAppByRequest(req, function (error, app) {
        if (error) return callback(error);

        user.list(function (error, result){
            if (error) return callback(new ldap.OperationsError(error.toString()));

            async.filter(result, apps.hasAccessTo.bind(null, app), function (error, result) {
                if (error) return callback(new ldap.OperationsError(error.toString()));

                callback(null, result);
            });
        });
    });
}

// helper function to deal with pagination
function finalSend(results, req, res, next) {
    var min = 0;
    var max = results.length;
    var cookie = null;
    var pageSize = 0;

    // check if this is a paging request, if so get the cookie for session info
    req.controls.forEach(function (control) {
        if (control.type === ldap.PagedResultsControl.OID) {
            pageSize = control.value.size;
            cookie = control.value.cookie;
        }
    });

    function sendPagedResults(start, end) {
        start = (start < min) ? min : start;
        end = (end > max || end < min) ? max : end;
        var i;

        for (i = start; i < end; i++) {
            res.send(results[i]);
        }

        return i;
    }

    if (cookie && Buffer.isBuffer(cookie)) {
        // we have pagination
        var first = min;
        if (cookie.length !== 0) {
            first = parseInt(cookie.toString(), 10);
        }
        var last = sendPagedResults(first, first + pageSize);

        var resultCookie;
        if (last < max) {
            resultCookie = new Buffer(last.toString());
        } else {
            resultCookie = new Buffer('');
        }

        res.controls.push(new ldap.PagedResultsControl({
            value: {
                size: pageSize, // correctness not required here
                cookie: resultCookie
            }
        }));
    } else {
        // no pagination simply send all
        results.forEach(function (result) {
            res.send(result);
        });
    }

    // all done
    res.end();
    next();
}

function userSearch(req, res, next) {
    debug('user search: dn %s, scope %s, filter %s (from %s)', req.dn.toString(), req.scope, req.filter.toString(), req.connection.ldap.id);

    getUsersWithAccessToApp(req, function (error, result) {
        if (error) return next(error);

        var results = [];

        // send user objects
        result.forEach(function (entry) {
            // skip entries with empty username. Some apps like owncloud can't deal with this
            if (!entry.username) return;

            var dn = ldap.parseDN('cn=' + entry.id + ',ou=users,dc=cloudron');

            var groups = [ GROUP_USERS_DN ];
            if (entry.admin) groups.push(GROUP_ADMINS_DN);

            var displayName = entry.displayName || entry.username || ''; // displayName can be empty and username can be null
            var nameParts = displayName.split(' ');
            var firstName = nameParts[0];
            var lastName = nameParts.length > 1  ? nameParts[nameParts.length - 1] : ''; // choose last part, if it exists

            var obj = {
                dn: dn.toString(),
                attributes: {
                    objectclass: ['user'],
                    objectcategory: 'person',
                    cn: entry.id,
                    uid: entry.id,
                    mail: entry.email,
                    mailAlternateAddress: entry.alternateEmail,
                    displayname: displayName,
                    givenName: firstName,
                    username: entry.username,
                    samaccountname: entry.username,      // to support ActiveDirectory clients
                    isadmin: entry.admin ? 1 : 0,
                    memberof: groups
                }
            };

            // http://www.zytrax.com/books/ldap/ape/core-schema.html#sn has 'name' as SUP which is a DirectoryString
            // which is required to have atleast one character if present
            if (lastName.length !== 0) obj.attributes.sn = lastName;

            // ensure all filter values are also lowercase
            var lowerCaseFilter = safe(function () { return ldap.parseFilter(req.filter.toString().toLowerCase()); }, null);
            if (!lowerCaseFilter) return next(new ldap.OperationsError(safe.error.toString()));

            if ((req.dn.equals(dn) || req.dn.parentOf(dn)) && lowerCaseFilter.matches(obj.attributes)) {
                results.push(obj);
            }
        });

        finalSend(results, req, res, next);
    });
}

function groupSearch(req, res, next) {
    debug('group search: dn %s, scope %s, filter %s (from %s)', req.dn.toString(), req.scope, req.filter.toString(), req.connection.ldap.id);

    getUsersWithAccessToApp(req, function (error, result) {
        if (error) return next(error);

        var results = [];

        var groups = [{
            name: 'users',
            admin: false
        }, {
            name: 'admins',
            admin: true
        }];

        groups.forEach(function (group) {
            var dn = ldap.parseDN('cn=' + group.name + ',ou=groups,dc=cloudron');
            var members = group.admin ? result.filter(function (entry) { return entry.admin; }) : result;

            var obj = {
                dn: dn.toString(),
                attributes: {
                    objectclass: ['group'],
                    cn: group.name,
                    memberuid: members.map(function(entry) { return entry.id; })
                }
            };

            // ensure all filter values are also lowercase
            var lowerCaseFilter = safe(function () { return ldap.parseFilter(req.filter.toString().toLowerCase()); }, null);
            if (!lowerCaseFilter) return next(new ldap.OperationsError(safe.error.toString()));

            if ((req.dn.equals(dn) || req.dn.parentOf(dn)) && lowerCaseFilter.matches(obj.attributes)) {
                results.push(obj);
            }
        });

        finalSend(results, req, res, next);
    });
}

function groupUsersCompare(req, res, next) {
    debug('group users compare: dn %s, attribute %s, value %s (from %s)', req.dn.toString(), req.attribute, req.value, req.connection.ldap.id);

    getUsersWithAccessToApp(req, function (error, result) {
        if (error) return next(error);

        // we only support memberuid here, if we add new group attributes later add them here
        if (req.attribute === 'memberuid') {
            var found = result.find(function (u) { return u.id === req.value; });
            if (found) return res.end(true);
        }

        res.end(false);
    });
}

function groupAdminsCompare(req, res, next) {
    debug('group admins compare: dn %s, attribute %s, value %s (from %s)', req.dn.toString(), req.attribute, req.value, req.connection.ldap.id);

    getUsersWithAccessToApp(req, function (error, result) {
        if (error) return next(error);

        // we only support memberuid here, if we add new group attributes later add them here
        if (req.attribute === 'memberuid') {
            var found = result.find(function (u) { return u.id === req.value; });
            if (found && found.admin) return res.end(true);
        }

        res.end(false);
    });
}

function mailboxSearch(req, res, next) {
    debug('mailbox search: dn %s, scope %s, filter %s (from %s)', req.dn.toString(), req.scope, req.filter.toString(), req.connection.ldap.id);

    if (!req.dn.rdns[0].attrs.cn) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    var name = req.dn.rdns[0].attrs.cn.value.toLowerCase();
    // allow login via email
    var parts = name.split('@');
    if (parts[1] === config.fqdn()) {
        name = parts[0];
    }

    mailboxdb.getMailbox(name, function (error, mailbox) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
        if (error) return next(new ldap.OperationsError(error.toString()));

        var obj = {
            dn: req.dn.toString(),
            attributes: {
                objectclass: ['mailbox'],
                objectcategory: 'mailbox',
                cn: mailbox.name,
                uid: mailbox.name,
                mail: mailbox.name + '@' + config.fqdn(),
                ownerType: mailbox.ownerType
            }
        };

        // ensure all filter values are also lowercase
        var lowerCaseFilter = safe(function () { return ldap.parseFilter(req.filter.toString().toLowerCase()); }, null);
        if (!lowerCaseFilter) return next(new ldap.OperationsError(safe.error.toString()));

        if (lowerCaseFilter.matches(obj.attributes)) {
            finalSend([ obj ], req, res, next);
        } else {
            res.end();
        }
    });
}

function mailAliasSearch(req, res, next) {
    debug('mail alias get: dn %s, scope %s, filter %s (from %s)', req.dn.toString(), req.scope, req.filter.toString(), req.connection.ldap.id);

    if (!req.dn.rdns[0].attrs.cn) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    mailboxdb.getAlias(req.dn.rdns[0].attrs.cn.value.toLowerCase(), function (error, alias) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
        if (error) return next(new ldap.OperationsError(error.toString()));

        // https://wiki.debian.org/LDAP/MigrationTools/Examples
        // https://docs.oracle.com/cd/E19455-01/806-5580/6jej518pp/index.html
        var obj = {
            dn: req.dn.toString(),
            attributes: {
                objectclass: ['nisMailAlias'],
                objectcategory: 'nisMailAlias',
                cn: alias.name,
                rfc822MailMember: alias.aliasTarget
            }
        };

        // ensure all filter values are also lowercase
        var lowerCaseFilter = safe(function () { return ldap.parseFilter(req.filter.toString().toLowerCase()); }, null);
        if (!lowerCaseFilter) return next(new ldap.OperationsError(safe.error.toString()));

        if (lowerCaseFilter.matches(obj.attributes)) {
            finalSend([ obj ], req, res, next);
        } else {
            res.end();
        }
    });
}

function mailingListSearch(req, res, next) {
    debug('mailing list get: dn %s, scope %s, filter %s (from %s)', req.dn.toString(), req.scope, req.filter.toString(), req.connection.ldap.id);

    if (!req.dn.rdns[0].attrs.cn) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    mailboxdb.getGroup(req.dn.rdns[0].attrs.cn.value.toLowerCase(), function (error, group) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
        if (error) return next(new ldap.OperationsError(error.toString()));

        // http://ldapwiki.willeke.com/wiki/Original%20Mailgroup%20Schema%20From%20Netscape
        var obj = {
            dn: req.dn.toString(),
            attributes: {
                objectclass: ['mailGroup'],
                objectcategory: 'mailGroup',
                cn: group.name,
                mail: group.name + '@' + config.fqdn(),
                mgrpRFC822MailMember: group.members
            }
        };

        // ensure all filter values are also lowercase
        var lowerCaseFilter = safe(function () { return ldap.parseFilter(req.filter.toString().toLowerCase()); }, null);
        if (!lowerCaseFilter) return next(new ldap.OperationsError(safe.error.toString()));

        if (lowerCaseFilter.matches(obj.attributes)) {
            finalSend([ obj ], req, res, next);
        } else {
            res.end();
        }
    });
}

function authenticateUser(req, res, next) {
    debug('user bind: %s (from %s)', req.dn.toString(), req.connection.ldap.id);

    // extract the common name which might have different attribute names
    var attributeName = Object.keys(req.dn.rdns[0].attrs)[0];
    var commonName = req.dn.rdns[0].attrs[attributeName].value;
    if (!commonName) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    var api;
    if (attributeName === 'mail') {
        api = user.verifyWithEmail;
    } else if (commonName.indexOf('@') !== -1) { // if mail is specified, enforce mail check
        api = user.verifyWithEmail;
    } else if (commonName.indexOf('uid-') === 0) {
        api = user.verify;
    } else {
        api = user.verifyWithUsername;
    }

    api(commonName, req.credentials || '', function (error, user) {
        if (error && error.reason === UserError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
        if (error && error.reason === UserError.WRONG_PASSWORD) return next(new ldap.InvalidCredentialsError(req.dn.toString()));
        if (error) return next(new ldap.OperationsError(error.message));

        req.user = user;

        next();
    });
}

function authorizeUserForApp(req, res, next) {
    assert(req.user);

    getAppByRequest(req, function (error, app) {
        if (error) return next(error);

        apps.hasAccessTo(app, req.user, function (error, result) {
            if (error) return next(new ldap.OperationsError(error.toString()));

            // we return no such object, to avoid leakage of a users existence
            if (!result) return next(new ldap.NoSuchObjectError(req.dn.toString()));

            eventlog.add(eventlog.ACTION_USER_LOGIN, { authType: 'ldap', appId: app.id }, { userId: req.user.id });

            res.end();
        });
    });
}

function authenticateMailbox(req, res, next) {
    if (!req.dn.rdns[0].attrs.cn) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    var name = req.dn.rdns[0].attrs.cn.value.toLowerCase();

    // allow login via email
    var parts = name.split('@');
    if (parts[1] === config.fqdn()) {
        name = parts[0];
    }

    mailboxdb.getMailbox(name, function (error, mailbox) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
        if (error) return next(new ldap.OperationsError(error.message));

        if (mailbox.ownerType === mailboxdb.TYPE_APP) {
            var addonId = req.dn.rdns[1].attrs.ou.value.toLowerCase(); // 'sendmail' or 'recvmail'
            var name;
            if (addonId === 'sendmail') name = 'MAIL_SMTP_PASSWORD';
            else if (addonId === 'recvmail') name = 'MAIL_IMAP_PASSWORD';
            else return next(new ldap.OperationsError('Invalid DN'));

            appdb.getAddonConfigByName(mailbox.ownerId, addonId, name, function (error, value) {
                if (error) return next(new ldap.OperationsError(error.message));
                if (req.credentials !== value) return next(new ldap.InvalidCredentialsError(req.dn.toString()));

                eventlog.add(eventlog.ACTION_APP_LOGIN, { authType: 'ldap', mailboxId: name }, { appId: mailbox.ownerId, addonId: addonId });
                return res.end();
            });
        } else if (mailbox.ownerType === mailboxdb.TYPE_USER) {
            authenticateUser(req, res, function (error) {
                if (error) return next(error);
                eventlog.add(eventlog.ACTION_USER_LOGIN, { authType: 'ldap', mailboxId: name }, { userId: req.user.username });
                res.end();
            });
        } else {
            return next(new ldap.OperationsError('Unknown ownerType for mailbox'));
        }
    });
}

function start(callback) {
    assert.strictEqual(typeof callback, 'function');

    var logger = {
        trace: NOOP,
        debug: NOOP,
        info: debug,
        warn: debug,
        error: console.error,
        fatal: console.error
    };

    gServer = ldap.createServer({ log: logger });

    gServer.search('ou=users,dc=cloudron', userSearch);
    gServer.search('ou=groups,dc=cloudron', groupSearch);
    gServer.bind('ou=users,dc=cloudron', authenticateUser, authorizeUserForApp);

    // http://www.ietf.org/proceedings/43/I-D/draft-srivastava-ldap-mail-00.txt
    gServer.search('ou=mailboxes,dc=cloudron', mailboxSearch);
    gServer.search('ou=mailaliases,dc=cloudron', mailAliasSearch);
    gServer.search('ou=mailinglists,dc=cloudron', mailingListSearch);

    gServer.bind('ou=recvmail,dc=cloudron', authenticateMailbox);
    gServer.bind('ou=sendmail,dc=cloudron', authenticateMailbox);

    gServer.compare('cn=users,ou=groups,dc=cloudron', groupUsersCompare);
    gServer.compare('cn=admins,ou=groups,dc=cloudron', groupAdminsCompare);

    // this is the bind for addons (after bind, they might search and authenticate)
    gServer.bind('ou=addons,dc=cloudron', function(req, res /*, next */) {
        debug('addons bind: %s', req.dn.toString()); // note: cn can be email or id
        res.end();
    });

    // this is the bind for apps (after bind, they might search and authenticate user)
    gServer.bind('ou=apps,dc=cloudron', function(req, res /*, next */) {
        // TODO: validate password
        debug('application bind: %s', req.dn.toString());
        res.end();
    });

    gServer.listen(config.get('ldapPort'), '0.0.0.0', callback);
}

function stop(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (gServer) gServer.close();

    callback();
}
