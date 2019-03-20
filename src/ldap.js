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
    users = require('./users.js'),
    UsersError = users.UsersError,
    ldap = require('ldapjs'),
    mail = require('./mail.js'),
    MailError = mail.MailError,
    mailboxdb = require('./mailboxdb.js'),
    path = require('path'),
    paths = require('./paths.js'),
    safe = require('safetydance');

var gServer = null;

var NOOP = function () {};

var GROUP_USERS_DN = 'cn=users,ou=groups,dc=cloudron';
var GROUP_ADMINS_DN = 'cn=admins,ou=groups,dc=cloudron';

// Will attach req.app if successful
function authenticateApp(req, res, next) {
    var sourceIp = req.connection.ldap.id.split(':')[0];
    if (sourceIp.split('.').length !== 4) return next(new ldap.InsufficientAccessRightsError('Missing source identifier'));

    apps.getByIpAddress(sourceIp, function (error, app) {
        if (error) return next(new ldap.OperationsError(error.message));
        if (!app) return next(new ldap.OperationsError('Could not detect app source'));

        req.app = app;

        next();
    });
}

function getUsersWithAccessToApp(req, callback) {
    assert.strictEqual(typeof req.app, 'object');
    assert.strictEqual(typeof callback, 'function');

    users.getAll(function (error, result) {
        if (error) return callback(new ldap.OperationsError(error.toString()));

        async.filter(result, apps.hasAccessTo.bind(null, req.app), function (error, allowedUsers) {
            if (error) return callback(new ldap.OperationsError(error.toString()));

            callback(null, allowedUsers);
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
            if (entry.admin || req.app.ownerId === entry.id) groups.push(GROUP_ADMINS_DN);

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
                    mailAlternateAddress: entry.fallbackEmail,
                    displayname: displayName,
                    givenName: firstName,
                    username: entry.username,
                    samaccountname: entry.username,      // to support ActiveDirectory clients
                    isadmin: (entry.admin || req.app.ownerId === entry.id) ? 1 : 0,
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
            var members = group.admin ? result.filter(function (entry) { return entry.admin || req.app.ownerId === entry.id; }) : result;

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
            if (found && (found.admin || req.app.ownerId == found.id)) return res.end(true);
        }

        res.end(false);
    });
}

function mailboxSearch(req, res, next) {
    debug('mailbox search: dn %s, scope %s, filter %s (from %s)', req.dn.toString(), req.scope, req.filter.toString(), req.connection.ldap.id);

    // if cn is set we only search for one mailbox specifically
    if (req.dn.rdns[0].attrs.cn) {
        var email = req.dn.rdns[0].attrs.cn.value.toLowerCase();
        var parts = email.split('@');
        if (parts.length !== 2) return next(new ldap.NoSuchObjectError(req.dn.toString()));

        mailboxdb.getMailbox(parts[0], parts[1], function (error, mailbox) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
            if (error) return next(new ldap.OperationsError(error.toString()));

            var obj = {
                dn: req.dn.toString(),
                attributes: {
                    objectclass: ['mailbox'],
                    objectcategory: 'mailbox',
                    cn: `${mailbox.name}@${mailbox.domain}`,
                    uid: `${mailbox.name}@${mailbox.domain}`,
                    mail: `${mailbox.name}@${mailbox.domain}`,
                    displayname: 'Max Mustermann',
                    givenName: 'Max',
                    username: 'mmustermann',
                    samaccountname: 'mmustermann'
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
    } else if (req.dn.rdns[0].attrs.domain) {
        var domain = req.dn.rdns[0].attrs.domain.value.toLowerCase();

        mailboxdb.listMailboxes(domain, function (error, result) {
            if (error) return next(new ldap.OperationsError(error.toString()));

            var results = [];

            // send mailbox objects
            result.forEach(function (mailbox) {
                var dn = ldap.parseDN(`cn=${mailbox.name}@${domain},domain=${domain},ou=mailboxes,dc=cloudron`);

                var obj = {
                    dn: dn.toString(),
                    attributes: {
                        objectclass: ['mailbox'],
                        objectcategory: 'mailbox',
                        cn: `${mailbox.name}@${domain}`,
                        uid: `${mailbox.name}@${domain}`,
                        mail: `${mailbox.name}@${domain}`
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
    } else {
        return next(new ldap.NoSuchObjectError(req.dn.toString()));
    }
}

function mailAliasSearch(req, res, next) {
    debug('mail alias get: dn %s, scope %s, filter %s (from %s)', req.dn.toString(), req.scope, req.filter.toString(), req.connection.ldap.id);

    if (!req.dn.rdns[0].attrs.cn) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    var email = req.dn.rdns[0].attrs.cn.value.toLowerCase();
    var parts = email.split('@');
    if (parts.length !== 2) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    mailboxdb.getAlias(parts[0], parts[1], function (error, alias) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
        if (error) return next(new ldap.OperationsError(error.toString()));

        // https://wiki.debian.org/LDAP/MigrationTools/Examples
        // https://docs.oracle.com/cd/E19455-01/806-5580/6jej518pp/index.html
        // member is fully qualified - https://docs.oracle.com/cd/E19957-01/816-6082-10/chap4.doc.html#43314
        var obj = {
            dn: req.dn.toString(),
            attributes: {
                objectclass: ['nisMailAlias'],
                objectcategory: 'nisMailAlias',
                cn: `${alias.name}@${alias.domain}`,
                rfc822MailMember: `${alias.aliasTarget}@${alias.domain}`
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

    var email = req.dn.rdns[0].attrs.cn.value.toLowerCase();
    var parts = email.split('@');
    if (parts.length !== 2) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    mailboxdb.getGroup(parts[0], parts[1], function (error, group) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
        if (error) return next(new ldap.OperationsError(error.toString()));

        // http://ldapwiki.willeke.com/wiki/Original%20Mailgroup%20Schema%20From%20Netscape
        // members are fully qualified (https://docs.oracle.com/cd/E19444-01/816-6018-10/groups.htm#13356)
        var obj = {
            dn: req.dn.toString(),
            attributes: {
                objectclass: ['mailGroup'],
                objectcategory: 'mailGroup',
                cn: `${group.name}@${group.domain}`, // fully qualified
                mail: `${group.name}@${group.domain}`,
                mgrpRFC822MailMember: group.members.map(function (m) { return `${m}@${group.domain}`; })
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

// Will attach req.user if successful
function authenticateUser(req, res, next) {
    debug('user bind: %s (from %s)', req.dn.toString(), req.connection.ldap.id);

    // extract the common name which might have different attribute names
    var attributeName = Object.keys(req.dn.rdns[0].attrs)[0];
    var commonName = req.dn.rdns[0].attrs[attributeName].value;
    if (!commonName) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    var api;
    if (attributeName === 'mail') {
        api = users.verifyWithEmail;
    } else if (commonName.indexOf('@') !== -1) { // if mail is specified, enforce mail check
        api = users.verifyWithEmail;
    } else if (commonName.indexOf('uid-') === 0) {
        api = users.verify;
    } else {
        api = users.verifyWithUsername;
    }

    api(commonName, req.credentials || '', function (error, user) {
        if (error && error.reason === UsersError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
        if (error && error.reason === UsersError.WRONG_PASSWORD) return next(new ldap.InvalidCredentialsError(req.dn.toString()));
        if (error) return next(new ldap.OperationsError(error.message));

        req.user = user;

        next();
    });
}

function authorizeUserForApp(req, res, next) {
    assert.strictEqual(typeof req.user, 'object');
    assert.strictEqual(typeof req.app, 'object');

    apps.hasAccessTo(req.app, req.user, function (error, result) {
        if (error) return next(new ldap.OperationsError(error.toString()));

        // we return no such object, to avoid leakage of a users existence
        if (!result) return next(new ldap.NoSuchObjectError(req.dn.toString()));

        eventlog.add(eventlog.ACTION_USER_LOGIN, { authType: 'ldap', appId: req.app.id }, { userId: req.user.id, user: users.removePrivateFields(req.user) });

        res.end();
    });
}

function authenticateUserMailbox(req, res, next) {
    debug('user mailbox auth: %s (from %s)', req.dn.toString(), req.connection.ldap.id);

    if (!req.dn.rdns[0].attrs.cn) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    var email = req.dn.rdns[0].attrs.cn.value.toLowerCase();
    var parts = email.split('@');
    if (parts.length !== 2) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    mail.getDomain(parts[1], function (error, domain) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
        if (error) return next(new ldap.OperationsError(error.message));

        if (!domain.enabled) return next(new ldap.NoSuchObjectError(req.dn.toString()));

        mailboxdb.getMailbox(parts[0], parts[1], function (error, mailbox) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
            if (error) return next(new ldap.OperationsError(error.message));

            users.verify(mailbox.ownerId, req.credentials || '', function (error, result) {
                if (error && error.reason === UsersError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
                if (error && error.reason === UsersError.WRONG_PASSWORD) return next(new ldap.InvalidCredentialsError(req.dn.toString()));
                if (error) return next(new ldap.OperationsError(error.message));

                eventlog.add(eventlog.ACTION_USER_LOGIN, { authType: 'ldap', mailboxId: email }, { userId: result.id, user: users.removePrivateFields(result) });
                res.end();
            });
        });
    });
}

function authenticateProftpd(req, res, next) {
    debug('proftpd addon auth: %s (from %s)', req.dn.toString(), req.connection.ldap.id);

    var sourceIp = req.connection.ldap.id.split(':')[0];
    if (sourceIp.split('.').length !== 4) return next(new ldap.InsufficientAccessRightsError('Missing source identifier'));
    if (sourceIp !== '127.0.0.1') return next(new ldap.InsufficientAccessRightsError('Source not authorized'));

    if (!req.dn.rdns[0].attrs.cn) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    var email = req.dn.rdns[0].attrs.cn.value.toLowerCase();
    var parts = email.split('@');
    if (parts.length !== 2) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    // actual user bind
    users.verifyWithUsername(parts[0], req.credentials, function (error) {
        if (error) return next(new ldap.InvalidCredentialsError(req.dn.toString()));

        debug('proftpd addon auth: success');

        res.end();
    });
}

function userSearchProftpd(req, res, next) {
    debug('proftpd user search: dn %s, scope %s, filter %s (from %s)', req.dn.toString(), req.scope, req.filter.toString(), req.connection.ldap.id);

    var sourceIp = req.connection.ldap.id.split(':')[0];
    if (sourceIp.split('.').length !== 4) return next(new ldap.InsufficientAccessRightsError('Missing source identifier'));
    if (sourceIp !== '127.0.0.1') return next(new ldap.InsufficientAccessRightsError('Source not authorized'));

    if (req.filter.attribute !== 'username' || !req.filter.value) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    var parts = req.filter.value.split('@');
    if (parts.length !== 2) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    var username = parts[0];
    var appFqdn = parts[1];

    apps.getByFqdn(appFqdn, function (error, app) {
        if (error) return next(new ldap.OperationsError(error.toString()));

        // only allow apps which specify "ftp" support in the localstorage addon
        if (!app.manifest.addons.localstorage || !app.manifest.addons.localstorage.ftp) return next(new ldap.UnavailableError('Not supported'));

        users.getByUsername(username, function (error, user) {
            if (error) return next(new ldap.OperationsError(error.toString()));

            apps.hasAccessTo(app, user, function (error, hasAccess) {
                if (error) return next(new ldap.OperationsError(error.toString()));
                if (!hasAccess) return next(new ldap.InsufficientAccessRightsError('Not authorized'));

                var obj = {
                    dn: ldap.parseDN(`cn=${username}@${appFqdn},ou=proftpd,dc=cloudron`).toString(),
                    attributes: {
                        homeDirectory: path.join(paths.APPS_DATA_DIR, app.id, 'data'),
                        objectclass: ['user'],
                        objectcategory: 'person',
                        cn: user.id,
                        uid: `${username}@${appFqdn}`,  // for bind after search
                        uidNumber: 1000,                // unix uid for ftp access
                        gidNumber: 1000                 // unix gid for ftp access
                    }
                };

                finalSend([ obj ], req, res, next);
            });
        });
    });
}

function authenticateMailAddon(req, res, next) {
    debug('mail addon auth: %s (from %s)', req.dn.toString(), req.connection.ldap.id);

    if (!req.dn.rdns[0].attrs.cn) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    var email = req.dn.rdns[0].attrs.cn.value.toLowerCase();
    var parts = email.split('@');
    if (parts.length !== 2) return next(new ldap.NoSuchObjectError(req.dn.toString()));

    const addonId = req.dn.rdns[1].attrs.ou.value.toLowerCase(); // 'sendmail' or 'recvmail'

    mail.getDomain(parts[1], function (error, domain) {
        if (error && error.reason === MailError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
        if (error) return next(new ldap.OperationsError(error.message));

        if (addonId === 'recvmail' && !domain.enabled) return next(new ldap.NoSuchObjectError(req.dn.toString()));

        let name;
        if (addonId === 'sendmail') name = 'MAIL_SMTP_PASSWORD';
        else if (addonId === 'recvmail') name = 'MAIL_IMAP_PASSWORD';
        else return next(new ldap.OperationsError('Invalid DN'));

        // note: with sendmail addon, apps can send mail without a mailbox (unlike users)
        appdb.getAppIdByAddonConfigValue(addonId, name, req.credentials || '', function (error, appId) {
            if (error && error.reason !== DatabaseError.NOT_FOUND) return next(new ldap.OperationsError(error.message));
            if (appId) { // matched app password
                eventlog.add(eventlog.ACTION_APP_LOGIN, { authType: 'ldap', mailboxId: email }, { appId: appId, addonId: addonId });
                return res.end();
            }

            mailboxdb.getMailbox(parts[0], parts[1], function (error, mailbox) {
                if (error && error.reason === DatabaseError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
                if (error) return next(new ldap.OperationsError(error.message));

                users.verify(mailbox.ownerId, req.credentials || '', function (error, result) {
                    if (error && error.reason === UsersError.NOT_FOUND) return next(new ldap.NoSuchObjectError(req.dn.toString()));
                    if (error && error.reason === UsersError.WRONG_PASSWORD) return next(new ldap.InvalidCredentialsError(req.dn.toString()));
                    if (error) return next(new ldap.OperationsError(error.message));

                    eventlog.add(eventlog.ACTION_USER_LOGIN, { authType: 'ldap', mailboxId: email }, { userId: result.id, user: users.removePrivateFields(result) });
                    res.end();
                });
            });
        });
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

    gServer.search('ou=users,dc=cloudron', authenticateApp, userSearch);
    gServer.search('ou=groups,dc=cloudron', authenticateApp, groupSearch);
    gServer.bind('ou=users,dc=cloudron', authenticateApp, authenticateUser, authorizeUserForApp);

    // http://www.ietf.org/proceedings/43/I-D/draft-srivastava-ldap-mail-00.txt
    gServer.search('ou=mailboxes,dc=cloudron', mailboxSearch); // haraka, dovecot
    gServer.bind('ou=mailboxes,dc=cloudron', authenticateUserMailbox); // apps like sogo can use domain=${domain} to authenticate a mailbox
    gServer.search('ou=mailaliases,dc=cloudron', mailAliasSearch); // haraka
    gServer.search('ou=mailinglists,dc=cloudron', mailingListSearch); // haraka

    gServer.bind('ou=recvmail,dc=cloudron', authenticateMailAddon); // dovecot
    gServer.bind('ou=sendmail,dc=cloudron', authenticateMailAddon); // haraka

    gServer.bind('ou=proftpd,dc=cloudron', authenticateProftpd);    // proftdp
    gServer.search('ou=proftpd,dc=cloudron', userSearchProftpd);

    gServer.compare('cn=users,ou=groups,dc=cloudron', authenticateApp, groupUsersCompare);
    gServer.compare('cn=admins,ou=groups,dc=cloudron', authenticateApp, groupAdminsCompare);

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
