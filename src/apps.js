'use strict';

exports = module.exports = {
    AppsError: AppsError,

    hasAccessTo: hasAccessTo,

    get: get,
    getByIpAddress: getByIpAddress,
    getAll: getAll,
    getAllByUser: getAllByUser,
    install: install,
    configure: configure,
    uninstall: uninstall,

    restore: restore,
    clone: clone,

    update: update,

    backup: backup,
    listBackups: listBackups,

    getLogs: getLogs,

    start: start,
    stop: stop,

    exec: exec,

    checkManifestConstraints: checkManifestConstraints,

    autoupdateApps: autoupdateApps,

    restoreInstalledApps: restoreInstalledApps,
    configureInstalledApps: configureInstalledApps,

    getAppConfig: getAppConfig,

    downloadFile: downloadFile,
    uploadFile: uploadFile,

    // exported for testing
    _validateHostname: validateHostname,
    _validatePortBindings: validatePortBindings,
    _validateAccessRestriction: validateAccessRestriction
};

var addons = require('./addons.js'),
    appdb = require('./appdb.js'),
    appstore = require('./appstore.js'),
    AppstoreError = require('./appstore.js').AppstoreError,
    assert = require('assert'),
    async = require('async'),
    backups = require('./backups.js'),
    BackupsError = backups.BackupsError,
    config = require('./config.js'),
    constants = require('./constants.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:apps'),
    docker = require('./docker.js'),
    domaindb = require('./domaindb.js'),
    domains = require('./domains.js'),
    DomainError = require('./domains.js').DomainError,
    eventlog = require('./eventlog.js'),
    fs = require('fs'),
    groups = require('./groups.js'),
    mailboxdb = require('./mailboxdb.js'),
    manifestFormat = require('cloudron-manifestformat'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    reverseProxy = require('./reverseproxy.js'),
    safe = require('safetydance'),
    semver = require('semver'),
    spawn = require('child_process').spawn,
    split = require('split'),
    superagent = require('superagent'),
    taskmanager = require('./taskmanager.js'),
    tld = require('tldjs'),
    TransformStream = require('stream').Transform,
    updateChecker = require('./updatechecker.js'),
    url = require('url'),
    util = require('util'),
    uuid = require('uuid'),
    validator = require('validator');

// http://dustinsenos.com/articles/customErrorsInNode
// http://code.google.com/p/v8/wiki/JavaScriptStackTraceApi
function AppsError(reason, errorOrMessage) {
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
util.inherits(AppsError, Error);
AppsError.INTERNAL_ERROR = 'Internal Error';
AppsError.EXTERNAL_ERROR = 'External Error';
AppsError.ALREADY_EXISTS = 'Already Exists';
AppsError.NOT_FOUND = 'Not Found';
AppsError.BAD_FIELD = 'Bad Field';
AppsError.BAD_STATE = 'Bad State';
AppsError.PORT_RESERVED = 'Port Reserved';
AppsError.PORT_CONFLICT = 'Port Conflict';
AppsError.BILLING_REQUIRED = 'Billing Required';
AppsError.ACCESS_DENIED = 'Access denied';
AppsError.BAD_CERTIFICATE = 'Invalid certificate';

// Hostname validation comes from RFC 1123 (section 2.1)
// Domain name validation comes from RFC 2181 (Name syntax)
// https://en.wikipedia.org/wiki/Hostname#Restrictions_on_valid_host_names
// We are validating the validity of the location-fqdn as host name (and not dns name)
function validateHostname(location, domain, hostname) {
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof hostname, 'string');

    const RESERVED_LOCATIONS = [
        constants.API_LOCATION,
        constants.SMTP_LOCATION,
        constants.IMAP_LOCATION
    ];
    if (RESERVED_LOCATIONS.indexOf(location) !== -1) return new AppsError(AppsError.BAD_FIELD, location + ' is reserved');

    if (hostname === config.adminFqdn()) return new AppsError(AppsError.BAD_FIELD, location + ' is reserved');

    // workaround https://github.com/oncletom/tld.js/issues/73
    var tmp = hostname.replace('_', '-');
    if (!tld.isValid(tmp)) return new AppsError(AppsError.BAD_FIELD, 'Hostname is not a valid domain name');

    if (hostname.length > 253) return new AppsError(AppsError.BAD_FIELD, 'Hostname length exceeds 253 characters');

    if (location) {
        // label validation
        if (location.length > 63) return new AppsError(AppsError.BAD_FIELD, 'Subdomain exceeds 63 characters');
        if (location.match(/^[A-Za-z0-9-]+$/) === null) return new AppsError(AppsError.BAD_FIELD, 'Subdomain can only contain alphanumerics and hyphen');
        if (location.startsWith('-') || location.endsWith('-')) return new AppsError(AppsError.BAD_FIELD, 'Subdomain cannot start or end with hyphen');
    }

    return null;
}

// validate the port bindings
function validatePortBindings(portBindings, tcpPorts) {
    assert.strictEqual(typeof portBindings, 'object');

    // keep the public ports in sync with firewall rules in scripts/initializeBaseUbuntuImage.sh
    // these ports are reserved even if we listen only on 127.0.0.1 because we setup HostIp to be 127.0.0.1
    // for custom tcp ports
    var RESERVED_PORTS = [
        22, /* ssh */
        25, /* smtp */
        53, /* dns */
        80, /* http */
        143, /* imap */
        202, /* caas ssh */
        443, /* https */
        465, /* smtps */
        587, /* submission */
        993, /* imaps */
        2003, /* graphite (lo) */
        2004, /* graphite (lo) */
        2020, /* install server */
        config.get('port'), /* app server (lo) */
        config.get('sysadminPort'), /* sysadmin app server (lo) */
        config.get('smtpPort'), /* internal smtp port (lo) */
        config.get('ldapPort'), /* ldap server (lo) */
        3306, /* mysql (lo) */
        4190, /* managesieve */
        8000 /* graphite (lo) */
    ];

    if (!portBindings) return null;

    var env;
    for (env in portBindings) {
        if (!/^[a-zA-Z0-9_]+$/.test(env)) return new AppsError(AppsError.BAD_FIELD, env + ' is not valid environment variable');

        if (!Number.isInteger(portBindings[env])) return new AppsError(AppsError.BAD_FIELD, portBindings[env] + ' is not an integer');
        if (RESERVED_PORTS.indexOf(portBindings[env]) !== -1) return new AppsError(AppsError.PORT_RESERVED, String(portBindings[env]));
        if (portBindings[env] <= 1023 || portBindings[env] > 65535) return new AppsError(AppsError.BAD_FIELD, portBindings[env] + ' is not in permitted range');

    }

    // it is OK if there is no 1-1 mapping between values in manifest.tcpPorts and portBindings. missing values implies
    // that the user wants the service disabled
    tcpPorts = tcpPorts || { };
    for (env in portBindings) {
        if (!(env in tcpPorts)) return new AppsError(AppsError.BAD_FIELD, 'Invalid portBindings ' + env);
    }

    return null;
}

function validateAccessRestriction(accessRestriction) {
    assert.strictEqual(typeof accessRestriction, 'object');

    if (accessRestriction === null) return null;

    if (accessRestriction.users) {
        if (!Array.isArray(accessRestriction.users)) return new AppsError(AppsError.BAD_FIELD, 'users array property required');
        if (!accessRestriction.users.every(function (e) { return typeof e === 'string'; })) return new AppsError(AppsError.BAD_FIELD, 'All users have to be strings');
    }

    if (accessRestriction.groups) {
        if (!Array.isArray(accessRestriction.groups)) return new AppsError(AppsError.BAD_FIELD, 'groups array property required');
        if (!accessRestriction.groups.every(function (e) { return typeof e === 'string'; })) return new AppsError(AppsError.BAD_FIELD, 'All groups have to be strings');
    }

    // TODO: maybe validate if the users and groups actually exist
    return null;
}

function validateMemoryLimit(manifest, memoryLimit) {
    assert.strictEqual(typeof manifest, 'object');
    assert.strictEqual(typeof memoryLimit, 'number');

    var min = manifest.memoryLimit || constants.DEFAULT_MEMORY_LIMIT;
    var max = os.totalmem() * 2; // this will overallocate since we don't allocate equal swap always (#466)

    // allow 0, which indicates that it is not set, the one from the manifest will be choosen but we don't commit any user value
    // this is needed so an app update can change the value in the manifest, and if not set by the user, the new value should be used
    if (memoryLimit === 0) return null;

    // a special value that indicates unlimited memory
    if (memoryLimit === -1) return null;

    if (memoryLimit < min) return new AppsError(AppsError.BAD_FIELD, 'memoryLimit too small');
    if (memoryLimit > max) return new AppsError(AppsError.BAD_FIELD, 'memoryLimit too large');

    return null;
}

// https://tools.ietf.org/html/rfc7034
function validateXFrameOptions(xFrameOptions) {
    assert.strictEqual(typeof xFrameOptions, 'string');

    if (xFrameOptions === 'DENY') return null;
    if (xFrameOptions === 'SAMEORIGIN') return null;

    var parts = xFrameOptions.split(' ');
    if (parts.length !== 2 || parts[0] !== 'ALLOW-FROM') return new AppsError(AppsError.BAD_FIELD, 'xFrameOptions must be "DENY", "SAMEORIGIN" or "ALLOW-FROM uri"' );

    var uri = url.parse(parts[1]);
    return (uri.protocol === 'http:' || uri.protocol === 'https:') ? null : new AppsError(AppsError.BAD_FIELD, 'xFrameOptions ALLOW-FROM uri must be a valid http[s] uri' );
}

function validateDebugMode(debugMode) {
    assert.strictEqual(typeof debugMode, 'object');

    if (debugMode === null) return null;
    if ('cmd' in debugMode && debugMode.cmd !== null && !Array.isArray(debugMode.cmd)) return new AppsError(AppsError.BAD_FIELD, 'debugMode.cmd must be an array or null' );
    if ('readonlyRootfs' in debugMode && typeof debugMode.readonlyRootfs !== 'boolean') return new AppsError(AppsError.BAD_FIELD, 'debugMode.readonlyRootfs must be a boolean' );

    return null;
}

function validateRobotsTxt(robotsTxt) {
    if (robotsTxt === null) return null;

    // this is the nginx limit on inline strings. if we really hit this, we have to generate a file
    if (robotsTxt.length > 4096) return new AppsError(AppsError.BAD_FIELD, 'robotsTxt must be less than 4096');

    // TODO: validate the robots file? we escape the string when templating the nginx config right now

    return null;
}

function validateBackupFormat(format) {
    if (format === 'tgz' || format == 'rsync') return null;

    return new AppsError(AppsError.BAD_FIELD, 'Invalid backup format');
}

function getDuplicateErrorDetails(location, portBindings, error) {
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof portBindings, 'object');
    assert.strictEqual(error.reason, DatabaseError.ALREADY_EXISTS);

    var match = error.message.match(/ER_DUP_ENTRY: Duplicate entry '(.*)' for key/);
    if (!match) {
        debug('Unexpected SQL error message.', error);
        return new AppsError(AppsError.INTERNAL_ERROR);
    }

    // check if the location conflicts
    if (match[1] === location) return new AppsError(AppsError.ALREADY_EXISTS);

    // check if any of the port bindings conflict
    for (var env in portBindings) {
        if (portBindings[env] === parseInt(match[1])) return new AppsError(AppsError.PORT_CONFLICT, match[1]);
    }

    return new AppsError(AppsError.ALREADY_EXISTS);
}

function getAppConfig(app) {
    return {
        manifest: app.manifest,
        location: app.location,
        domain: app.domain,
        fqdn: app.fqdn,
        accessRestriction: app.accessRestriction,
        portBindings: app.portBindings,
        memoryLimit: app.memoryLimit,
        xFrameOptions: app.xFrameOptions || 'SAMEORIGIN'
    };
}

function getIconUrlSync(app) {
    var iconPath = paths.APP_ICONS_DIR + '/' + app.id + '.png';
    return fs.existsSync(iconPath) ? '/api/v1/apps/' + app.id + '/icon' : null;
}

function hasAccessTo(app, user, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (app.accessRestriction === null) return callback(null, true);

    // check user access
    if (app.accessRestriction.users.some(function (e) { return e === user.id; })) return callback(null, true);

    // check group access
    groups.getGroups(user.id, function (error, groupIds) {
        if (error) return callback(null, false);

        const isAdmin = groupIds.indexOf(constants.ADMIN_GROUP_ID) !== -1;

        if (isAdmin) return callback(null, true); // admins can always access any app

        if (!app.accessRestriction.groups) return callback(null, false);

        if (app.accessRestriction.groups.some(function (gid) { return groupIds.indexOf(gid) !== -1; })) return callback(null, true);

        callback(null, false);
    });
}

function get(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    appdb.get(appId, function (error, app) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND, 'No such app'));
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

        domaindb.get(app.domain, function (error, result) {
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

            app.iconUrl = getIconUrlSync(app);
            app.fqdn = domains.fqdn(app.location, app.domain, result.provider);

            callback(null, app);
        });
    });
}

function getByIpAddress(ip, callback) {
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    docker.getContainerIdByIp(ip, function (error, containerId) {
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

        appdb.getByContainerId(containerId, function (error, app) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND, 'No such app'));
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

            domaindb.get(app.domain, function (error, result) {
                if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                app.iconUrl = getIconUrlSync(app);
                app.fqdn = domains.fqdn(app.location, app.domain, result.provider);

                callback(null, app);
            });
        });
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    appdb.getAll(function (error, apps) {
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

        async.eachSeries(apps, function (app, iteratorDone) {
            domaindb.get(app.domain, function (error, result) {
                if (error) return iteratorDone(new AppsError(AppsError.INTERNAL_ERROR, error));

                app.iconUrl = getIconUrlSync(app);
                app.fqdn = domains.fqdn(app.location, app.domain, result.provider);

                iteratorDone();
            });
        }, function (error) {
            if (error) return callback(error);

            callback(null, apps);
        });
    });
}

function getAllByUser(user, callback) {
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof callback, 'function');

    getAll(function (error, result) {
        if (error) return callback(error);

        async.filter(result, function (app, iteratorDone) {
            hasAccessTo(app, user, iteratorDone);
        }, callback);
    });
}

function downloadManifest(appStoreId, manifest, callback) {
    if (!appStoreId && !manifest) return callback(new AppsError(AppsError.BAD_FIELD, 'Neither manifest nor appStoreId provided'));

    if (!appStoreId) return callback(null, '', manifest);

    var parts = appStoreId.split('@');

    var url = config.apiServerOrigin() + '/api/v1/apps/' + parts[0] + (parts[1] ? '/versions/' + parts[1] : '');

    debug('downloading manifest from %s', url);

    superagent.get(url).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(new AppsError(AppsError.EXTERNAL_ERROR, 'Network error downloading manifest:' + error.message));

        if (result.statusCode !== 200) return callback(new AppsError(AppsError.NOT_FOUND, util.format('Failed to get app info from store.', result.statusCode, result.text)));

        callback(null, parts[0], result.body.manifest);
    });
}

function install(data, auditSource, callback) {
    assert(data && typeof data === 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    var location = data.location.toLowerCase(),
        domain = data.domain.toLowerCase(),
        portBindings = data.portBindings || null,
        accessRestriction = data.accessRestriction || null,
        icon = data.icon || null,
        cert = data.cert || null,
        key = data.key || null,
        memoryLimit = data.memoryLimit || 0,
        xFrameOptions = data.xFrameOptions || 'SAMEORIGIN',
        sso = 'sso' in data ? data.sso : null,
        debugMode = data.debugMode || null,
        robotsTxt = data.robotsTxt || null,
        enableBackup = 'enableBackup' in data ? data.enableBackup : true,
        backupId = data.backupId || null,
        backupFormat = data.backupFormat || 'tgz';

    assert(data.appStoreId || data.manifest); // atleast one of them is required

    downloadManifest(data.appStoreId, data.manifest, function (error, appStoreId, manifest) {
        if (error) return callback(error);

        error = manifestFormat.parse(manifest);
        if (error) return callback(new AppsError(AppsError.BAD_FIELD, 'Manifest error: ' + error.message));

        error = checkManifestConstraints(manifest);
        if (error) return callback(error);

        error = validatePortBindings(portBindings, manifest.tcpPorts);
        if (error) return callback(error);

        error = validateAccessRestriction(accessRestriction);
        if (error) return callback(error);

        error = validateMemoryLimit(manifest, memoryLimit);
        if (error) return callback(error);

        error = validateXFrameOptions(xFrameOptions);
        if (error) return callback(error);

        error = validateDebugMode(debugMode);
        if (error) return callback(error);

        error = validateRobotsTxt(robotsTxt);
        if (error) return callback(error);

        error = validateBackupFormat(backupFormat);
        if (error) return callback(error);

        if ('sso' in data && !('optionalSso' in manifest)) return callback(new AppsError(AppsError.BAD_FIELD, 'sso can only be specified for apps with optionalSso'));
        // if sso was unspecified, enable it by default if possible
        if (sso === null) sso = !!manifest.addons['ldap'] || !!manifest.addons['oauth'];

        var appId = uuid.v4();

        if (icon) {
            if (!validator.isBase64(icon)) return callback(new AppsError(AppsError.BAD_FIELD, 'icon is not base64'));

            if (!safe.fs.writeFileSync(path.join(paths.APP_ICONS_DIR, appId + '.png'), new Buffer(icon, 'base64'))) {
                return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Error saving icon:' + safe.error.message));
            }
        }

        domains.get(domain, function (error, domainObject) {
            if (error && error.reason === DomainError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND, 'No such domain'));
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Could not get domain info:' + error.message));

            var fqdn = domains.fqdn(location, domain, domainObject.provider);

            error = validateHostname(location, domain, fqdn);
            if (error) return callback(error);

            if (cert && key) {
                error = reverseProxy.validateCertificate(fqdn, cert, key);
                if (error) return callback(new AppsError(AppsError.BAD_CERTIFICATE, error.message));
            }

            debug('Will install app with id : ' + appId);

            appstore.purchase(appId, appStoreId, function (error) {
                if (error && error.reason === AppstoreError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND));
                if (error && error.reason === AppstoreError.BILLING_REQUIRED) return callback(new AppsError(AppsError.BILLING_REQUIRED, error.message));
                if (error && error.reason === AppstoreError.EXTERNAL_ERROR) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));
                if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                var data = {
                    accessRestriction: accessRestriction,
                    memoryLimit: memoryLimit,
                    xFrameOptions: xFrameOptions,
                    sso: sso,
                    debugMode: debugMode,
                    mailboxName: (location ? location : manifest.title.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')) + '.app',
                    restoreConfig: backupId ? { backupId: backupId, backupFormat: backupFormat } : null,
                    enableBackup: enableBackup,
                    robotsTxt: robotsTxt
                };

                appdb.add(appId, appStoreId, manifest, location, domain, portBindings, data, function (error) {
                    if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(getDuplicateErrorDetails(location, portBindings, error));
                    if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                    // save cert to boxdata/certs
                    if (cert && key) {
                        if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, fqdn + '.user.cert'), cert)) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Error saving cert: ' + safe.error.message));
                        if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, fqdn + '.user.key'), key)) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Error saving key: ' + safe.error.message));
                    }

                    taskmanager.restartAppTask(appId);

                    // fetch fresh app object for eventlog
                    get(appId, function (error, result) {
                        if (error) return callback(error);

                        eventlog.add(eventlog.ACTION_APP_INSTALL, auditSource, { appId: appId, app: result });

                        callback(null, { id : appId });
                    });
                });
            });
        });
    });
}

function configure(appId, data, auditSource, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert(data && typeof data === 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    get(appId, function (error, app) {
        if (error) return callback(error);

        var domain, location, portBindings, values = { };
        if ('location' in data) location = values.location = data.location.toLowerCase();
        else location = app.location;

        if ('domain' in data) domain = values.domain = data.domain.toLowerCase();
        else domain = app.domain;

        if ('accessRestriction' in data) {
            values.accessRestriction = data.accessRestriction;
            error = validateAccessRestriction(values.accessRestriction);
            if (error) return callback(error);
        }

        if ('portBindings' in data) {
            portBindings = values.portBindings = data.portBindings;
            error = validatePortBindings(values.portBindings, app.manifest.tcpPorts);
            if (error) return callback(error);
        } else {
            portBindings = app.portBindings;
        }

        if ('memoryLimit' in data) {
            values.memoryLimit = data.memoryLimit;
            error = validateMemoryLimit(app.manifest, values.memoryLimit);
            if (error) return callback(error);
        }

        if ('xFrameOptions' in data) {
            values.xFrameOptions = data.xFrameOptions;
            error = validateXFrameOptions(values.xFrameOptions);
            if (error) return callback(error);
        }

        if ('debugMode' in data) {
            values.debugMode = data.debugMode;
            error = validateDebugMode(values.debugMode);
            if (error) return callback(error);
        }

        if ('robotsTxt' in data) {
            values.robotsTxt = data.robotsTxt || null;
            error = validateRobotsTxt(values.robotsTxt);
            if (error) return callback(error);
        }

        domains.get(domain, function (error, domainObject) {
            if (error && error.reason === DomainError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND, 'No such domain'));
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Could not get domain info:' + error.message));

            var fqdn = domains.fqdn(location, domain, domainObject.provider);

            error = validateHostname(location, domain, fqdn);
            if (error) return callback(error);

            // save cert to boxdata/certs. TODO: move this to apptask when we have a real task queue
            if ('cert' in data && 'key' in data) {
                if (data.cert && data.key) {
                    error = reverseProxy.validateCertificate(fqdn, data.cert, data.key);
                    if (error) return callback(new AppsError(AppsError.BAD_CERTIFICATE, error.message));

                    if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, `${fqdn}.user.cert`), data.cert)) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Error saving cert: ' + safe.error.message));
                    if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, `${fqdn}.user.key`), data.key)) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Error saving key: ' + safe.error.message));
                } else { // remove existing cert/key
                    if (!safe.fs.unlinkSync(path.join(paths.APP_CERTS_DIR, `${fqdn}.user.cert`))) debug('Error removing cert: ' + safe.error.message);
                    if (!safe.fs.unlinkSync(path.join(paths.APP_CERTS_DIR, `${fqdn}..user.key`))) debug('Error removing key: ' + safe.error.message);
                }
            }

            if ('enableBackup' in data) values.enableBackup = data.enableBackup;

            values.oldConfig = getAppConfig(app);

            debug('Will configure app with id:%s values:%j', appId, values);

            var oldName = (app.location ? app.location : app.manifest.title.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')) + '.app';
            var newName = (location ? location : app.manifest.title.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')) + '.app';
            mailboxdb.updateName(oldName, values.oldConfig.domain, newName, domain, function (error) {
                if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(new AppsError(AppsError.ALREADY_EXISTS, 'This mailbox is already taken'));
                if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.BAD_STATE));
                if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                appdb.setInstallationCommand(appId, appdb.ISTATE_PENDING_CONFIGURE, values, function (error) {
                    if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(getDuplicateErrorDetails(location, portBindings, error));
                    if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.BAD_STATE));
                    if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                    taskmanager.restartAppTask(appId);

                    // fetch fresh app object for eventlog
                    get(appId, function (error, result) {
                        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                        eventlog.add(eventlog.ACTION_APP_CONFIGURE, auditSource, { appId: appId, app: result });

                        callback(null);
                    });
                });
            });
        });
    });
}

function update(appId, data, auditSource, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert(data && typeof data === 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('Will update app with id:%s', appId);

    downloadManifest(data.appStoreId, data.manifest, function (error, appStoreId, manifest) {
        if (error) return callback(error);

        var updateConfig = { };

        error = manifestFormat.parse(manifest);
        if (error) return callback(new AppsError(AppsError.BAD_FIELD, 'Manifest error:' + error.message));

        error = checkManifestConstraints(manifest);
        if (error) return callback(error);

        updateConfig.manifest = manifest;

        if ('icon' in data) {
            if (data.icon) {
                if (!validator.isBase64(data.icon)) return callback(new AppsError(AppsError.BAD_FIELD, 'icon is not base64'));

                if (!safe.fs.writeFileSync(path.join(paths.APP_ICONS_DIR, appId + '.png'), new Buffer(data.icon, 'base64'))) {
                    return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Error saving icon:' + safe.error.message));
                }
            } else {
                safe.fs.unlinkSync(path.join(paths.APP_ICONS_DIR, appId + '.png'));
            }
        }

        get(appId, function (error, app) {
            if (error) return callback(error);

            // prevent user from installing a app with different manifest id over an existing app
            // this allows cloudron install -f --app <appid> for an app installed from the appStore
            if (app.manifest.id !== updateConfig.manifest.id) {
                if (!data.force) return callback(new AppsError(AppsError.BAD_FIELD, 'manifest id does not match. force to override'));
                // clear appStoreId so that this app does not get updates anymore
                updateConfig.appStoreId = '';
            }

            // do not update apps in debug mode
            if (app.debugMode && !data.force) return callback(new AppsError(AppsError.BAD_STATE, 'debug mode enabled. force to override'));

            // Ensure we update the memory limit in case the new app requires more memory as a minimum
            // 0 and -1 are special updateConfig for memory limit indicating unset and unlimited
            if (app.memoryLimit > 0 && updateConfig.manifest.memoryLimit && app.memoryLimit < updateConfig.manifest.memoryLimit) {
                updateConfig.memoryLimit = updateConfig.manifest.memoryLimit;
            }

            appdb.setInstallationCommand(appId, data.force ? appdb.ISTATE_PENDING_FORCE_UPDATE : appdb.ISTATE_PENDING_UPDATE, { updateConfig: updateConfig }, function (error) {
                if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.BAD_STATE)); // might be a bad guess
                if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                taskmanager.restartAppTask(appId);

                eventlog.add(eventlog.ACTION_APP_UPDATE, auditSource, { appId: appId, toManifest: manifest, fromManifest: app.manifest, force: data.force, app: app });

                // clear update indicator, if update fails, it will come back through the update checker
                updateChecker.resetAppUpdateInfo(appId);

                callback(null);
            });
        });
    });
}

function appLogFilter(app) {
    var names = [ app.id ].concat(addons.getContainerNamesSync(app, app.manifest.addons));

    return names.map(function (name) { return 'CONTAINER_NAME=' + name; });
}

function getLogs(appId, options, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('Getting logs for %s', appId);

    get(appId, function (error, app) {
        if (error) return callback(error);

        var lines = options.lines || 100,
            follow = !!options.follow,
            format = options.format || 'json';

        var args = [ '--no-pager', '--lines=' + lines ];
        if (follow) args.push('--follow');
        if (format == 'short') args.push('--output=short', '-a'); else args.push('--output=json');
        args = args.concat(appLogFilter(app));

        var cp = spawn('/bin/journalctl', args);

        var transformStream = split(function mapper(line) {
            if (format !== 'json') return line + '\n';

            var obj = safe.JSON.parse(line);
            if (!obj) return undefined;

            var source = obj.CONTAINER_NAME.slice(app.id.length + 1);
            return JSON.stringify({
                realtimeTimestamp: obj.__REALTIME_TIMESTAMP,
                monotonicTimestamp: obj.__MONOTONIC_TIMESTAMP,
                message: obj.MESSAGE,
                source: source || 'main'
            }) + '\n';
        });

        transformStream.close = cp.kill.bind(cp, 'SIGKILL'); // closing stream kills the child process

        cp.stdout.pipe(transformStream);

        return callback(null, transformStream);
    });
}

function restore(appId, data, auditSource, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof data, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('Will restore app with id:%s', appId);

    get(appId, function (error, app) {
        if (error) return callback(error);

        // for empty or null backupId, use existing manifest to mimic a reinstall
        var func = data.backupId ? backups.get.bind(null, data.backupId) : function (next) { return next(null, { manifest: app.manifest }); };

        func(function (error, backupInfo) {
            if (error && error.reason === BackupsError.NOT_FOUND) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));
            if (error && error.reason === BackupsError.EXTERNAL_ERROR) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

            if (!backupInfo.manifest) callback(new AppsError(AppsError.EXTERNAL_ERROR, 'Could not get restore manifest'));

            // re-validate because this new box version may not accept old configs
            error = checkManifestConstraints(backupInfo.manifest);
            if (error) return callback(error);

            var values = {
                restoreConfig: data.backupId ? { backupId: data.backupId, backupFormat: backupInfo.format } : null, // when null, apptask simply reinstalls
                manifest: backupInfo.manifest,

                oldConfig: getAppConfig(app)
            };

            appdb.setInstallationCommand(appId, appdb.ISTATE_PENDING_RESTORE, values, function (error) {
                if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.BAD_STATE)); // might be a bad guess
                if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                taskmanager.restartAppTask(appId);

                eventlog.add(eventlog.ACTION_APP_RESTORE, auditSource, { appId: appId, app: app });

                callback(null);
            });
        });
    });
}

function clone(appId, data, auditSource, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof data, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('Will clone app with id:%s', appId);

    var location = data.location.toLowerCase(),
        domain = data.domain.toLowerCase(),
        portBindings = data.portBindings || null,
        backupId = data.backupId;

    assert.strictEqual(typeof backupId, 'string');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof portBindings, 'object');

    get(appId, function (error, app) {
        if (error) return callback(error);

        backups.get(backupId, function (error, backupInfo) {
            if (error && error.reason === BackupsError.EXTERNAL_ERROR) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));
            if (error && error.reason === BackupsError.NOT_FOUND) return callback(new AppsError(AppsError.EXTERNAL_ERROR, 'Backup not found'));
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

            if (!backupInfo.manifest) callback(new AppsError(AppsError.EXTERNAL_ERROR, 'Could not get restore config'));

            // re-validate because this new box version may not accept old configs
            error = checkManifestConstraints(backupInfo.manifest);
            if (error) return callback(error);

            error = validatePortBindings(portBindings, backupInfo.manifest.tcpPorts);
            if (error) return callback(error);

            domains.get(domain, function (error, domainObject) {
                if (error && error.reason === DomainError.NOT_FOUND) return callback(new AppsError(AppsError.EXTERNAL_ERROR, 'No such domain'));
                if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Could not get domain info:' + error.message));

                error = validateHostname(location, domain, domains.fqdn(location, domain, domainObject.provider));
                if (error) return callback(error);

                var newAppId = uuid.v4(), manifest = backupInfo.manifest;

                appstore.purchase(newAppId, app.appStoreId, function (error) {
                    if (error && error.reason === AppstoreError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND));
                    if (error && error.reason === AppstoreError.BILLING_REQUIRED) return callback(new AppsError(AppsError.BILLING_REQUIRED, error.message));
                    if (error && error.reason === AppstoreError.EXTERNAL_ERROR) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));
                    if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                    var data = {
                        installationState: appdb.ISTATE_PENDING_CLONE,
                        memoryLimit: app.memoryLimit,
                        accessRestriction: app.accessRestriction,
                        xFrameOptions: app.xFrameOptions,
                        restoreConfig: { backupId: backupId, backupFormat: backupInfo.format },
                        sso: !!app.sso,
                        mailboxName: (location ? location : manifest.title.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')) + '.app',
                        enableBackup: app.enableBackup,
                        robotsTxt: app.robotsTxt
                    };

                    appdb.add(newAppId, app.appStoreId, manifest, location, domain, portBindings, data, function (error) {
                        if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(getDuplicateErrorDetails(location, portBindings, error));
                        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                        taskmanager.restartAppTask(newAppId);

                        // fetch fresh app object for eventlog
                        get(appId, function (error, result) {
                            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                            eventlog.add(eventlog.ACTION_APP_CLONE, auditSource, { appId: newAppId, oldAppId: appId, backupId: backupId, oldApp: app, newApp: result });

                            callback(null, { id : newAppId });
                        });
                    });
                });
            });
        });
    });
}

function uninstall(appId, auditSource, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('Will uninstall app with id:%s', appId);

    get(appId, function (error, app) {
        if (error) return callback(error);

        appstore.unpurchase(appId, app.appStoreId, function (error) {
            if (error && error.reason === AppstoreError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND));
            if (error && error.reason === AppstoreError.BILLING_REQUIRED) return callback(new AppsError(AppsError.BILLING_REQUIRED, error.message));
            if (error && error.reason === AppstoreError.EXTERNAL_ERROR) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

            taskmanager.stopAppTask(appId, function () {
                appdb.setInstallationCommand(appId, appdb.ISTATE_PENDING_UNINSTALL, function (error) {
                    if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND, 'No such app'));
                    if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                    eventlog.add(eventlog.ACTION_APP_UNINSTALL, auditSource, { appId: appId, app: app });

                    taskmanager.startAppTask(appId, callback);
                });
            });
        });
    });
}

function start(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('Will start app with id:%s', appId);

    appdb.setRunCommand(appId, appdb.RSTATE_PENDING_START, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.BAD_STATE)); // might be a bad guess
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

        taskmanager.restartAppTask(appId);

        callback(null);
    });
}

function stop(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('Will stop app with id:%s', appId);

    appdb.setRunCommand(appId, appdb.RSTATE_PENDING_STOP, function (error) {
        if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.BAD_STATE)); // might be a bad guess
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

        taskmanager.restartAppTask(appId);

        callback(null);
    });
}

function checkManifestConstraints(manifest) {
    assert(manifest && typeof manifest === 'object');

    if (!manifest.dockerImage) return new AppsError(AppsError.BAD_FIELD, 'Missing dockerImage'); // dockerImage is optional in manifest

    if (semver.valid(manifest.maxBoxVersion) && semver.gt(config.version(), manifest.maxBoxVersion)) {
        return new AppsError(AppsError.BAD_FIELD, 'Box version exceeds Apps maxBoxVersion');
    }

    if (semver.valid(manifest.minBoxVersion) && semver.gt(manifest.minBoxVersion, config.version())) {
        return new AppsError(AppsError.BAD_FIELD, 'App version requires a new platform version');
    }

    return null;
}

function exec(appId, options, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    var cmd = options.cmd || [ '/bin/bash' ];
    assert(util.isArray(cmd) && cmd.length > 0);

    get(appId, function (error, app) {
        if (error) return callback(error);

        if (app.installationState !== appdb.ISTATE_INSTALLED || app.runState !== appdb.RSTATE_RUNNING) {
            return callback(new AppsError(AppsError.BAD_STATE, 'App not installed or running'));
        }

        var container = docker.connection.getContainer(app.containerId);

        var execOptions = {
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            // A pseudo tty is a terminal which processes can detect (for example, disable colored output)
            // Creating a pseudo terminal also assigns a terminal driver which detects control sequences
            // When passing binary data, tty must be disabled. In addition, the stdout/stderr becomes a single
            // unified stream because of the nature of a tty (see https://github.com/docker/docker/issues/19696)
            Tty: options.tty,
            Cmd: cmd
        };

        container.exec(execOptions, function (error, exec) {
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));
            var startOptions = {
                Detach: false,
                Tty: options.tty,
                // hijacking upgrades the docker connection from http to tcp. because of this upgrade,
                // we can work with half-close connections (not defined in http). this way, the client
                // can properly signal that stdin is EOF by closing it's side of the socket. In http,
                // the whole connection will be dropped when stdin get EOF.
                // https://github.com/apocas/dockerode/commit/b4ae8a03707fad5de893f302e4972c1e758592fe
                hijack: true,
                stream: true,
                stdin: true,
                stdout: true,
                stderr: true
            };
            exec.start(startOptions, function(error, stream /* in hijacked mode, this is a net.socket */) {
                if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                if (options.rows && options.columns) {
                    exec.resize({ h: options.rows, w: options.columns }, function (error) { if (error) debug('Error resizing console', error); });
                }

                return callback(null, stream);
            });
        });
    });
}

function autoupdateApps(updateInfo, auditSource, callback) { // updateInfo is { appId -> { manifest } }
    assert.strictEqual(typeof updateInfo, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    function canAutoupdateApp(app, newManifest) {
        if ((semver.major(app.manifest.version) !== 0) && (semver.major(app.manifest.version) !== semver.major(newManifest.version))) return new Error('Major version change'); // major changes are blocking

        var newTcpPorts = newManifest.tcpPorts || { };
        var portBindings = app.portBindings; // this is never null

        for (var env in portBindings) {
            if (!(env in newTcpPorts)) return new Error(env + ' was in use but new update removes it');
        }

        // it's fine if one or more (unused) keys got removed
        return null;
    }

    if (!updateInfo) return callback(null);

    async.eachSeries(Object.keys(updateInfo), function iterator(appId, iteratorDone) {
        get(appId, function (error, app) {
            if (error) {
                debug('Cannot autoupdate app %s : %s', appId, error.message);
                return iteratorDone();
            }

            error = canAutoupdateApp(app, updateInfo[appId].manifest);
            if (error) {
                debug('app %s requires manual update. %s', appId, error.message);
                return iteratorDone();
            }

            var data = {
                manifest: updateInfo[appId].manifest,
                force: false
            };

            update(appId, data, auditSource, function (error) {
                if (error) debug('Error initiating autoupdate of %s. %s', appId, error.message);

                iteratorDone(null);
            });
        });
    }, callback);
}

function backup(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    appdb.exists(appId, function (error, exists) {
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));
        if (!exists) return callback(new AppsError(AppsError.NOT_FOUND));

        appdb.setInstallationCommand(appId, appdb.ISTATE_PENDING_BACKUP, function (error) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.BAD_STATE)); // might be a bad guess
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

            taskmanager.restartAppTask(appId);

            callback(null);
        });
    });
}


function listBackups(page, perPage, appId, callback) {
    assert(typeof page === 'number' && page > 0);
    assert(typeof perPage === 'number' && perPage > 0);

    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    appdb.exists(appId, function (error, exists) {
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));
        if (!exists) return callback(new AppsError(AppsError.NOT_FOUND));

        backups.getByAppIdPaged(page, perPage, appId, function (error, results) {
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

            callback(null, results);
        });
    });
}

function restoreInstalledApps(callback) {
    assert.strictEqual(typeof callback, 'function');

    appdb.getAll(function (error, apps) {
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

        async.map(apps, function (app, iteratorDone) {
            debug('marking %s for restore', app.fqdn);

            backups.getByAppIdPaged(1, 1, app.id, function (error, results) {
                var restoreConfig = !error && results.length ? { backupId: results[0].id, backupFormat: results[0].format } : null;

                appdb.setInstallationCommand(app.id, appdb.ISTATE_PENDING_RESTORE, { restoreConfig: restoreConfig, oldConfig: null }, function (error) {
                    if (error) debug('did not mark %s for restore', app.fqdn, error);

                    iteratorDone(); // always succeed
                });
            });
        }, callback);
    });
}

function configureInstalledApps(callback) {
    assert.strictEqual(typeof callback, 'function');

    appdb.getAll(function (error, apps) {
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

        async.map(apps, function (app, iteratorDone) {
            debug('marking %s for reconfigure', app.fqdn);

            appdb.setInstallationCommand(app.id, appdb.ISTATE_PENDING_CONFIGURE, { oldConfig: null }, function (error) {
                if (error) debug('did not mark %s for reconfigure', app.fqdn, error);

                iteratorDone(); // always succeed
            });
        }, callback);
    });
}

function downloadFile(appId, filePath, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof filePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    exec(appId, { cmd: [ 'stat', '--printf=%F-%s', filePath ], tty: true }, function (error, stream) {
        if (error) return callback(error);

        var data = '';
        stream.setEncoding('utf8');
        stream.on('data', function (d) { data += d; });
        stream.on('end', function () {
            var parts = data.split('-');
            if (parts.length !== 2) return callback(new AppsError(AppsError.NOT_FOUND, 'file does not exist'));

            var type = parts[0], filename, cmd, size;

            if (type === 'regular file') {
                cmd = [ 'cat', filePath ];
                size = parseInt(parts[1], 10);
                filename = path.basename(filePath);
                if (isNaN(size)) return callback(new AppsError(AppsError.NOT_FOUND, 'file does not exist'));
            } else if (type === 'directory') {
                cmd = ['tar', 'zcf', '-', '-C', filePath, '.'];
                filename = path.basename(filePath) + '.tar.gz';
                size = 0; // unknown
            } else {
                return callback(new AppsError(AppsError.NOT_FOUND, 'only files or dirs can be downloaded'));
            }

            exec(appId, { cmd: cmd , tty: false }, function (error, stream) {
                if (error) return callback(error);

                var stdoutStream = new TransformStream({
                    transform: function (chunk, ignoredEncoding, callback) {
                        this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;

                        while (true) {
                            if (this._buffer.length < 8) break; // header is 8 bytes

                            var type = this._buffer.readUInt8(0);
                            var len = this._buffer.readUInt32BE(4);

                            if (this._buffer.length < (8 + len)) break; // not enough

                            var payload = this._buffer.slice(8, 8 + len);

                            this._buffer = this._buffer.slice(8+len); // consumed

                            if (type === 1) this.push(payload);
                        }

                        callback();
                    }
                });

                stream.pipe(stdoutStream);

                return callback(null, stdoutStream, { filename: filename, size: size });
            });
        });
    });
}

function uploadFile(appId, sourceFilePath, destFilePath, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof sourceFilePath, 'string');
    assert.strictEqual(typeof destFilePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    exec(appId, { cmd: [ 'bash', '-c', 'cat - > ' + destFilePath ], tty: false }, function (error, stream) {
        if (error) return callback(error);

        var readFile = fs.createReadStream(sourceFilePath);
        readFile.on('error', callback);

        readFile.pipe(stream);

        callback(null);
    });
}
