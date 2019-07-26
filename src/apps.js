'use strict';

exports = module.exports = {
    AppsError: AppsError,

    hasAccessTo: hasAccessTo,
    removeInternalFields: removeInternalFields,
    removeRestrictedFields: removeRestrictedFields,

    get: get,
    getByContainerId: getByContainerId,
    getByIpAddress: getByIpAddress,
    getByFqdn: getByFqdn,
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

    canAutoupdateApp: canAutoupdateApp,
    autoupdateApps: autoupdateApps,

    restoreInstalledApps: restoreInstalledApps,
    configureInstalledApps: configureInstalledApps,

    getAppConfig: getAppConfig,
    getDataDir: getDataDir,

    downloadFile: downloadFile,
    uploadFile: uploadFile,

    PORT_TYPE_TCP: 'tcp',
    PORT_TYPE_UDP: 'udp',

    // exported for testing
    _validatePortBindings: validatePortBindings,
    _validateAccessRestriction: validateAccessRestriction,
    _translatePortBindings: translatePortBindings
};

var appdb = require('./appdb.js'),
    appstore = require('./appstore.js'),
    AppstoreError = require('./appstore.js').AppstoreError,
    assert = require('assert'),
    async = require('async'),
    backups = require('./backups.js'),
    BackupsError = backups.BackupsError,
    constants = require('./constants.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:apps'),
    docker = require('./docker.js'),
    domaindb = require('./domaindb.js'),
    domains = require('./domains.js'),
    DomainsError = require('./domains.js').DomainsError,
    eventlog = require('./eventlog.js'),
    fs = require('fs'),
    mail = require('./mail.js'),
    manifestFormat = require('cloudron-manifestformat'),
    once = require('once'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    reverseProxy = require('./reverseproxy.js'),
    safe = require('safetydance'),
    semver = require('semver'),
    settings = require('./settings.js'),
    spawn = require('child_process').spawn,
    split = require('split'),
    superagent = require('superagent'),
    taskmanager = require('./taskmanager.js'),
    TransformStream = require('stream').Transform,
    updateChecker = require('./updatechecker.js'),
    util = require('util'),
    uuid = require('uuid'),
    validator = require('validator'),
    _ = require('underscore');

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
AppsError.PLAN_LIMIT = 'Plan Limit';
AppsError.ACCESS_DENIED = 'Access denied';
AppsError.BAD_CERTIFICATE = 'Invalid certificate';

// validate the port bindings
function validatePortBindings(portBindings, manifest) {
    assert.strictEqual(typeof portBindings, 'object');
    assert.strictEqual(typeof manifest, 'object');

    // keep the public ports in sync with firewall rules in setup/start/cloudron-firewall.sh
    // these ports are reserved even if we listen only on 127.0.0.1 because we setup HostIp to be 127.0.0.1
    // for custom tcp ports
    var RESERVED_PORTS = [
        22, /* ssh */
        25, /* smtp */
        53, /* dns */
        80, /* http */
        143, /* imap */
        202, /* alternate ssh */
        222, /* proftd */
        443, /* https */
        465, /* smtps */
        587, /* submission */
        993, /* imaps */
        2003, /* graphite (lo) */
        2004, /* graphite (lo) */
        2020, /* mail server */
        2514, /* cloudron-syslog (lo) */
        constants.PORT, /* app server (lo) */
        constants.SYSADMIN_PORT, /* sysadmin app server (lo) */
        constants.INTERNAL_SMTP_PORT, /* internal smtp port (lo) */
        constants.LDAP_PORT,
        3306, /* mysql (lo) */
        4190, /* managesieve */
        8000, /* ESXi monitoring */
        8417, /* graphite (lo) */
    ];

    if (!portBindings) return null;

    for (let portName in portBindings) {
        if (!/^[a-zA-Z0-9_]+$/.test(portName)) return new AppsError(AppsError.BAD_FIELD, `${portName} is not a valid environment variable`);

        const hostPort = portBindings[portName];
        if (!Number.isInteger(hostPort)) return new AppsError(AppsError.BAD_FIELD, `${hostPort} is not an integer`);
        if (RESERVED_PORTS.indexOf(hostPort) !== -1) return new AppsError(AppsError.PORT_RESERVED, String(hostPort));
        if (hostPort <= 1023 || hostPort > 65535) return new AppsError(AppsError.BAD_FIELD, `${hostPort} is not in permitted range`);

    }

    // it is OK if there is no 1-1 mapping between values in manifest.tcpPorts and portBindings. missing values implies
    // that the user wants the service disabled
    const tcpPorts = manifest.tcpPorts || { };
    const udpPorts = manifest.udpPorts || { };
    for (let portName in portBindings) {
        if (!(portName in tcpPorts) && !(portName in udpPorts)) return new AppsError(AppsError.BAD_FIELD, `Invalid portBindings ${portName}`);
    }

    return null;
}

function translatePortBindings(portBindings, manifest) {
    assert.strictEqual(typeof portBindings, 'object');
    assert.strictEqual(typeof manifest, 'object');

    if (!portBindings) return null;

    let result = {};
    const tcpPorts = manifest.tcpPorts || { };

    for (let portName in portBindings) {
        const portType = portName in tcpPorts ? exports.PORT_TYPE_TCP : exports.PORT_TYPE_UDP;
        result[portName] = { hostPort: portBindings[portName], type: portType };
    }
    return result;
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
    assert.strictEqual(typeof format, 'string');

    if (format === 'tgz' || format == 'rsync') return null;

    return new AppsError(AppsError.BAD_FIELD, 'Invalid backup format');
}

function validateLabel(label) {
    if (label === null) return null;

    if (label.length > 128) return new AppsError(AppsError.BAD_FIELD, 'label must be less than 128');

    return null;
}

function validateTags(tags) {
    if (!Array.isArray(tags)) return new AppsError(AppsError.BAD_FIELD, 'tags must be an array of strings');
    if (tags.length > 64) return new AppsError(AppsError.BAD_FIELD, 'Can only set up to 64 tags');

    if (tags.some(tag => (!tag || typeof tag !== 'string'))) return new AppsError(AppsError.BAD_FIELD, 'tags must be an array of non-empty strings');
    if (tags.some(tag => tag.length > 128)) return new AppsError(AppsError.BAD_FIELD, 'tag must be less than 128');

    return null;
}

function validateEnv(env) {
    for (let key in env) {
        if (key.length > 512) return new AppsError(AppsError.BAD_FIELD, 'Max env var key length is 512');
        // http://pubs.opengroup.org/onlinepubs/000095399/basedefs/xbd_chap08.html
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) return new AppsError(AppsError.BAD_FIELD, `"${key}" is not a valid environment variable`);
    }

    return null;
}

function validateDataDir(dataDir) {
    if (dataDir === '') return null; // revert back to default dataDir

    if (path.resolve(dataDir) !== dataDir) return new AppsError(AppsError.BAD_FIELD, 'dataDir must be an absolute path');

    // nfs shares will have the directory mounted already
    let stat = safe.fs.lstatSync(dataDir);
    if (stat) {
        if (!stat.isDirectory()) return new AppsError(AppsError.BAD_FIELD, `dataDir ${dataDir} is not a directory`);
        let entries = safe.fs.readdirSync(dataDir);
        if (!entries) return new AppsError(AppsError.BAD_FIELD, `dataDir ${dataDir} could not be listed`);
        if (entries.length !== 0) return new AppsError(AppsError.BAD_FIELD, `dataDir ${dataDir} is not empty`);
    }

    // backup logic relies on paths not overlapping (because it recurses)
    if (dataDir.startsWith(paths.APPS_DATA_DIR)) return new AppsError(AppsError.BAD_FIELD, `dataDir ${dataDir} cannot be inside apps data`);

    // if we made it this far, it cannot start with any of these realistically
    const fhs = [ '/bin', '/boot', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/run', '/sbin', '/tmp', '/usr' ];
    if (fhs.some((p) => dataDir.startsWith(p))) return new AppsError(AppsError.BAD_FIELD, `dataDir ${dataDir} cannot be placed inside this location`);

    return null;
}

function getDuplicateErrorDetails(error, location, domainObject, portBindings, alternateDomains) {
    assert.strictEqual(error.reason, DatabaseError.ALREADY_EXISTS);
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domainObject, 'object');
    assert.strictEqual(typeof portBindings, 'object');
    assert(Array.isArray(alternateDomains));

    var match = error.message.match(/ER_DUP_ENTRY: Duplicate entry '(.*)' for key '(.*)'/);
    if (!match) {
        debug('Unexpected SQL error message.', error);
        return new AppsError(AppsError.INTERNAL_ERROR, error);
    }

    // check if the location or alternateDomains conflicts
    if (match[2] === 'subdomain') {
        // mysql reports a unique conflict with a dash: eg. domain:example.com subdomain:test => test-example.com
        if (match[1] === `${location}-${domainObject.domain}`) return new AppsError(AppsError.ALREADY_EXISTS, `Domain '${domains.fqdn(location, domainObject)}' is in use`);

        // check alternateDomains
        let tmp = alternateDomains.filter(function (d) {
            return match[1] === `${d.subdomain}-${d.domain}`;
        });

        if (tmp.length > 0) return new AppsError(AppsError.ALREADY_EXISTS, `Alternate domain '${tmp[0].subdomain}.${tmp[0].domain}' is in use`);
    }

    // check if any of the port bindings conflict
    for (let portName in portBindings) {
        if (portBindings[portName] === parseInt(match[1])) return new AppsError(AppsError.PORT_CONFLICT, match[1]);
    }

    return new AppsError(AppsError.ALREADY_EXISTS, `${match[2]} '${match[1]}' is in use`);
}

// app configs that is useful for 'archival' into the app backup config.json
function getAppConfig(app) {
    return {
        manifest: app.manifest,
        location: app.location,
        domain: app.domain,
        fqdn: app.fqdn,
        accessRestriction: app.accessRestriction,
        portBindings: app.portBindings,
        memoryLimit: app.memoryLimit,

        robotsTxt: app.robotsTxt,
        sso: app.sso,
        alternateDomains: app.alternateDomains || [],
        env: app.env,
        dataDir: app.dataDir
    };
}

function getDataDir(app, dataDir) {
    return dataDir || path.join(paths.APPS_DATA_DIR, app.id, 'data');
}

function removeInternalFields(app) {
    return _.pick(app,
        'id', 'appStoreId', 'installationState', 'installationProgress', 'runState', 'health',
        'location', 'domain', 'fqdn', 'mailboxName',
        'accessRestriction', 'manifest', 'portBindings', 'iconUrl', 'memoryLimit',
        'sso', 'debugMode', 'robotsTxt', 'enableBackup', 'creationTime', 'updateTime', 'ts', 'tags',
        'label', 'alternateDomains', 'env', 'enableAutomaticUpdate', 'dataDir');
}

// non-admins can only see these
function removeRestrictedFields(app) {
    return _.pick(app,
        'id', 'appStoreId', 'installationState', 'installationProgress', 'runState', 'health',
        'location', 'domain', 'fqdn', 'manifest', 'portBindings', 'iconUrl', 'creationTime', 'ts', 'tags', 'label');
}

function getIconUrlSync(app) {
    const iconUrl = '/api/v1/apps/' + app.id + '/icon';

    const userIconPath = `${paths.APP_ICONS_DIR}/${app.id}.user.png`;
    if (safe.fs.existsSync(userIconPath)) return iconUrl;

    const appstoreIconPath = `${paths.APP_ICONS_DIR}/${app.id}.png`;
    if (safe.fs.existsSync(appstoreIconPath)) return iconUrl;

    return null;
}

function postProcess(app, domainObjectMap) {
    let result = {};
    for (let portName in app.portBindings) {
        result[portName] = app.portBindings[portName].hostPort;
    }
    app.portBindings = result;

    app.iconUrl = getIconUrlSync(app);
    app.fqdn = domains.fqdn(app.location, domainObjectMap[app.domain]);
    app.alternateDomains.forEach(function (ad) { ad.fqdn = domains.fqdn(ad.subdomain, domainObjectMap[ad.domain]); });
}

function hasAccessTo(app, user, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof user, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (app.accessRestriction === null) return callback(null, true);

    // check user access
    if (app.accessRestriction.users.some(function (e) { return e === user.id; })) return callback(null, true);

    if (user.admin) return callback(null, true); // admins can always access any app

    if (!app.accessRestriction.groups) return callback(null, false);

    if (app.accessRestriction.groups.some(function (gid) { return user.groupIds.indexOf(gid) !== -1; })) return callback(null, true);

    callback(null, false);
}

function getDomainObjectMap(callback) {
    assert.strictEqual(typeof callback, 'function');

    domaindb.getAll(function (error, domainObjects) {
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

        let domainObjectMap = {};
        for (let d of domainObjects) { domainObjectMap[d.domain] = d; }

        callback(null, domainObjectMap);
    });
}

function get(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    getDomainObjectMap(function (error, domainObjectMap) {
        if (error) return callback(error);

        appdb.get(appId, function (error, app) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND, 'No such app'));
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

            postProcess(app, domainObjectMap);

            callback(null, app);
        });
    });
}

function getByContainerId(containerId, callback) {
    assert.strictEqual(typeof containerId, 'string');
    assert.strictEqual(typeof callback, 'function');

    getDomainObjectMap(function (error, domainObjectMap) {
        if (error) return callback(error);

        appdb.getByContainerId(containerId, function (error, app) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND, 'No such app'));
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

            postProcess(app, domainObjectMap);

            callback(null, app);
        });
    });
}

// returns the app associated with this IP (app or scheduler)
function getByIpAddress(ip, callback) {
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    docker.getContainerIdByIp(ip, function (error, containerId) {
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

        docker.inspect(containerId, function (error, result) {
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

            const appId = safe.query(result, 'Config.Labels.appId', null);
            if (!appId) return callback(new AppsError(AppsError.NOT_FOUND, 'No such app'));

            get(appId, callback);
        });
    });
}

function getByFqdn(fqdn, callback) {
    assert.strictEqual(typeof fqdn, 'string');
    assert.strictEqual(typeof callback, 'function');

    getAll(function (error, result) {
        if (error) return callback(error);

        var app = result.find(function (a) { return a.fqdn === fqdn; });
        if (!app) return callback(new AppsError(AppsError.NOT_FOUND, 'No such app'));

        callback(null, app);
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    getDomainObjectMap(function (error, domainObjectMap) {
        if (error) return callback(error);

        appdb.getAll(function (error, apps) {
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

            apps.forEach((app) => postProcess(app, domainObjectMap));

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

    var url = settings.apiServerOrigin() + '/api/v1/apps/' + parts[0] + (parts[1] ? '/versions/' + parts[1] : '');

    debug('downloading manifest from %s', url);

    superagent.get(url).timeout(30 * 1000).end(function (error, result) {
        if (error && !error.response) return callback(new AppsError(AppsError.EXTERNAL_ERROR, 'Network error downloading manifest:' + error.message));

        if (result.statusCode !== 200) return callback(new AppsError(AppsError.NOT_FOUND, util.format('Failed to get app info from store.', result.statusCode, result.text)));

        callback(null, parts[0], result.body.manifest);
    });
}

function mailboxNameForLocation(location, manifest) {
    return (location ? location : manifest.title.toLowerCase().replace(/[^a-zA-Z0-9]/g, '')) + '.app';
}

function install(data, user, auditSource, callback) {
    assert(data && typeof data === 'object');
    assert(user && typeof user === 'object');
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
        sso = 'sso' in data ? data.sso : null,
        debugMode = data.debugMode || null,
        robotsTxt = data.robotsTxt || null,
        enableBackup = 'enableBackup' in data ? data.enableBackup : true,
        enableAutomaticUpdate = 'enableAutomaticUpdate' in data ? data.enableAutomaticUpdate : true,
        backupId = data.backupId || null,
        backupFormat = data.backupFormat || 'tgz',
        alternateDomains = data.alternateDomains || [],
        env = data.env || {},
        mailboxName = data.mailboxName || '',
        label = data.label || null,
        tags = data.tags || [];

    assert(data.appStoreId || data.manifest); // atleast one of them is required

    downloadManifest(data.appStoreId, data.manifest, function (error, appStoreId, manifest) {
        if (error) return callback(error);

        error = manifestFormat.parse(manifest);
        if (error) return callback(new AppsError(AppsError.BAD_FIELD, 'Manifest error: ' + error.message));

        error = checkManifestConstraints(manifest);
        if (error) return callback(error);

        error = validatePortBindings(portBindings, manifest);
        if (error) return callback(error);

        error = validateAccessRestriction(accessRestriction);
        if (error) return callback(error);

        error = validateMemoryLimit(manifest, memoryLimit);
        if (error) return callback(error);

        error = validateDebugMode(debugMode);
        if (error) return callback(error);

        error = validateRobotsTxt(robotsTxt);
        if (error) return callback(error);

        error = validateBackupFormat(backupFormat);
        if (error) return callback(error);

        error = validateLabel(label);
        if (error) return callback(error);

        error = validateTags(tags);
        if (error) return callback(error);

        if ('sso' in data && !('optionalSso' in manifest)) return callback(new AppsError(AppsError.BAD_FIELD, 'sso can only be specified for apps with optionalSso'));
        // if sso was unspecified, enable it by default if possible
        if (sso === null) sso = !!manifest.addons['ldap'] || !!manifest.addons['oauth'];

        error = validateEnv(env);
        if (error) return callback(error);

        if (mailboxName) {
            error = mail.validateName(mailboxName);
            if (error) return callback(error);
        } else {
            mailboxName = mailboxNameForLocation(location, manifest);
        }

        var appId = uuid.v4();

        if (icon) {
            if (!validator.isBase64(icon)) return callback(new AppsError(AppsError.BAD_FIELD, 'icon is not base64'));

            if (!safe.fs.writeFileSync(path.join(paths.APP_ICONS_DIR, appId + '.png'), Buffer.from(icon, 'base64'))) {
                return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Error saving icon:' + safe.error.message));
            }
        }

        domains.get(domain, function (error, domainObject) {
            if (error && error.reason === DomainsError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND, 'No such domain'));
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Could not get domain info:' + error.message));

            error = domains.validateHostname(location, domainObject);
            if (error) return callback(new AppsError(AppsError.BAD_FIELD, 'Bad location: ' + error.message));

            if (cert && key) {
                error = reverseProxy.validateCertificate(location, domainObject, { cert, key });
                if (error) return callback(new AppsError(AppsError.BAD_CERTIFICATE, error.message));
            }

            debug('Will install app with id : ' + appId);

            var data = {
                accessRestriction: accessRestriction,
                memoryLimit: memoryLimit,
                sso: sso,
                debugMode: debugMode,
                mailboxName: mailboxName,
                restoreConfig: backupId ? { backupId: backupId, backupFormat: backupFormat } : null,
                enableBackup: enableBackup,
                enableAutomaticUpdate: enableAutomaticUpdate,
                robotsTxt: robotsTxt,
                alternateDomains: alternateDomains,
                env: env
            };

            appdb.add(appId, appStoreId, manifest, location, domain, translatePortBindings(portBindings, manifest), data, function (error) {
                if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(getDuplicateErrorDetails(error, location, domainObject, portBindings, data.alternateDomains));
                if (error && error.reason === DatabaseError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND, error.message));
                if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                purchaseApp({ appId: appId, appstoreId: appStoreId, manifestId: manifest.id }, function (error) {
                    if (error) return callback(error);

                    // save cert to boxdata/certs
                    if (cert && key) {
                        let error = reverseProxy.setAppCertificateSync(location, domainObject, { cert, key });
                        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Error setting cert: ' + error.message));
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

function configure(appId, data, user, auditSource, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert(data && typeof data === 'object');
    assert(user && typeof user === 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    get(appId, function (error, app) {
        if (error) return callback(error);

        let domain, location, portBindings, values = { };
        if ('location' in data && 'domain' in data) {
            location = values.location = data.location.toLowerCase();
            domain = values.domain = data.domain.toLowerCase();
        } else {
            location = app.location;
            domain = app.domain;
        }

        if ('accessRestriction' in data) {
            values.accessRestriction = data.accessRestriction;
            error = validateAccessRestriction(values.accessRestriction);
            if (error) return callback(error);
        }

        if ('portBindings' in data) {
            error = validatePortBindings(data.portBindings, app.manifest);
            if (error) return callback(error);
            values.portBindings = translatePortBindings(data.portBindings, app.manifest);
            portBindings = data.portBindings;
        } else {
            portBindings = app.portBindings;
        }

        if ('memoryLimit' in data) {
            values.memoryLimit = data.memoryLimit;
            error = validateMemoryLimit(app.manifest, values.memoryLimit);
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

        if ('mailboxName' in data) {
            if (data.mailboxName) {
                error = mail.validateName(data.mailboxName);
                if (error) return callback(error);
                values.mailboxName = data.mailboxName;
            } else {
                values.mailboxName = mailboxNameForLocation(location, app.manifest);
            }
        } else { // keep existing name or follow the new location
            values.mailboxName = app.mailboxName.endsWith('.app') ? mailboxNameForLocation(location, app.manifest) : app.mailboxName;
        }

        if ('alternateDomains' in data) {
            // TODO validate all subdomains [{ domain: '', subdomain: ''}]
            values.alternateDomains = data.alternateDomains;
        }

        if ('env' in data) {
            values.env = data.env;
            error = validateEnv(data.env);
            if (error) return callback(error);
        }

        if ('dataDir' in data && data.dataDir !== app.dataDir) {
            error = validateDataDir(data.dataDir);
            if (error) return callback(error);
            values.dataDir = data.dataDir;
        }

        if ('label' in data) {
            error = validateLabel(data.label);
            if (error) return callback(error);
            values.label = data.label;
        }

        if ('tags' in data) {
            error = validateTags(data.tags);
            if (error) return callback(error);
            values.tags = data.tags;
        }

        if ('icon' in data) {
            if (data.icon) {
                if (!validator.isBase64(data.icon)) return callback(new AppsError(AppsError.BAD_FIELD, 'icon is not base64'));

                if (!safe.fs.writeFileSync(path.join(paths.APP_ICONS_DIR, appId + '.user.png'), Buffer.from(data.icon, 'base64'))) {
                    return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Error saving icon:' + safe.error.message));
                }
            } else {
                safe.fs.unlinkSync(path.join(paths.APP_ICONS_DIR, appId + '.user.png'));
            }
        }

        domains.get(domain, function (error, domainObject) {
            if (error && error.reason === DomainsError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND, 'No such domain'));
            if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Could not get domain info:' + error.message));

            error = domains.validateHostname(location, domainObject);
            if (error) return callback(new AppsError(AppsError.BAD_FIELD, 'Bad location: ' + error.message));

            // save cert to boxdata/certs. TODO: move this to apptask when we have a real task queue
            if ('cert' in data && 'key' in data) {
                if (data.cert && data.key) {
                    error = reverseProxy.validateCertificate(location, domainObject, { cert: data.cert, key: data.key });
                    if (error) return callback(new AppsError(AppsError.BAD_CERTIFICATE, error.message));
                }

                error = reverseProxy.setAppCertificateSync(location, domainObject, { cert: data.cert, key: data.key });
                if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Error setting cert: ' + error.message));
            }

            if ('enableBackup' in data) values.enableBackup = data.enableBackup;
            if ('enableAutomaticUpdate' in data) values.enableAutomaticUpdate = data.enableAutomaticUpdate;

            values.oldConfig = getAppConfig(app);

            debug(`configure: id:${appId}`);

            appdb.setInstallationCommand(appId, appdb.ISTATE_PENDING_CONFIGURE, values, function (error) {
                if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(getDuplicateErrorDetails(error, location, domainObject, portBindings, data.alternateDomains));
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
}

function update(appId, data, auditSource, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert(data && typeof data === 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug(`update: id:${appId}`);

    get(appId, function (error, app) {
        if (error) return callback(error);

        downloadManifest(data.appStoreId, data.manifest, function (error, appStoreId, manifest) {
            if (error) return callback(error);

            var updateConfig = { };

            error = manifestFormat.parse(manifest);
            if (error) return callback(new AppsError(AppsError.BAD_FIELD, 'Manifest error:' + error.message));

            error = checkManifestConstraints(manifest);
            if (error) return callback(error);

            updateConfig.manifest = manifest;

            // prevent user from installing a app with different manifest id over an existing app
            // this allows cloudron install -f --app <appid> for an app installed from the appStore
            if (app.manifest.id !== updateConfig.manifest.id) {
                if (!data.force) return callback(new AppsError(AppsError.BAD_FIELD, 'manifest id does not match. force to override'));
                // clear appStoreId so that this app does not get updates anymore
                updateConfig.appStoreId = '';
            }

            // suffix '0' if prerelease is missing for semver.lte to work as expected
            const currentVersion = semver.prerelease(app.manifest.version) ? app.manifest.version : `${app.manifest.version}-0`;
            const updateVersion = semver.prerelease(updateConfig.manifest.version) ? updateConfig.manifest.version : `${updateConfig.manifest.version}-0`;
            if (app.appStoreId !== '' && semver.lte(updateVersion, currentVersion)) {
                if (!data.force) return callback(new AppsError(AppsError.BAD_FIELD, 'Downgrades are not permitted for apps installed from AppStore. force to override'));
            }

            if ('icon' in data) {
                if (data.icon) {
                    if (!validator.isBase64(data.icon)) return callback(new AppsError(AppsError.BAD_FIELD, 'icon is not base64'));

                    if (!safe.fs.writeFileSync(path.join(paths.APP_ICONS_DIR, appId + '.user.png'), Buffer.from(data.icon, 'base64'))) {
                        return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Error saving icon:' + safe.error.message));
                    }
                } else {
                    safe.fs.unlinkSync(path.join(paths.APP_ICONS_DIR, appId + '.user.png'));
                }
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

function getLogs(appId, options, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    assert.strictEqual(typeof options.lines, 'number');
    assert.strictEqual(typeof options.format, 'string');
    assert.strictEqual(typeof options.follow, 'boolean');

    debug('Getting logs for %s', appId);

    get(appId, function (error, app) {
        if (error) return callback(error);

        var lines = options.lines === -1 ? '+1' : options.lines,
            format = options.format || 'json',
            follow = options.follow;

        assert.strictEqual(typeof format, 'string');

        var args = [ '--lines=' + lines ];
        if (follow) args.push('--follow', '--retry', '--quiet'); // same as -F. to make it work if file doesn't exist, --quiet to not output file headers, which are no logs
        args.push(path.join(paths.LOG_DIR, appId, 'apptask.log'));
        args.push(path.join(paths.LOG_DIR, appId, 'app.log'));
        if (app.manifest.addons && app.manifest.addons.redis) args.push(path.join(paths.LOG_DIR, `redis-${appId}/app.log`));

        var cp = spawn('/usr/bin/tail', args);

        var transformStream = split(function mapper(line) {
            if (format !== 'json') return line + '\n';

            var data = line.split(' '); // logs are <ISOtimestamp> <msg>
            var timestamp = (new Date(data[0])).getTime();
            if (isNaN(timestamp)) timestamp = 0;
            var message = line.slice(data[0].length+1);

            // ignore faulty empty logs
            if (!timestamp && !message) return;

            return JSON.stringify({
                realtimeTimestamp: timestamp * 1000,
                message: message,
                source: appId
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

                eventlog.add(eventlog.ACTION_APP_RESTORE, auditSource, { app: app, backupId: backupInfo.id, fromManifest: app.manifest, toManifest: backupInfo.manifest });

                callback(null);
            });
        });
    });
}

function purchaseApp(data, callback) {
    assert.strictEqual(typeof data, 'object');
    assert.strictEqual(typeof callback, 'function');

    appstore.purchaseApp(data, function (error) {
        if (!error) return callback();

        // if purchase failed, rollback the appdb record
        appdb.del(data.appId, function (delError) {
            if (delError) debug('install: Failed to rollback app installation.', delError);

            if (error.reason === AppstoreError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND, error.message));
            if (error && error.reason === AppstoreError.PLAN_LIMIT) return callback(new AppsError(AppsError.PLAN_LIMIT, error.message));
            if (error && error.reason === AppstoreError.INVALID_TOKEN) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));
            if (error && error.reason === AppstoreError.LICENSE_ERROR) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));
            if (error && error.reason === AppstoreError.NOT_REGISTERED) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));
            if (error && error.reason === AppstoreError.EXTERNAL_ERROR) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));

            callback(new AppsError(AppsError.INTERNAL_ERROR, error));
        });
    });
}

function clone(appId, data, user, auditSource, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof data, 'object');
    assert(user && typeof user === 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('Will clone app with id:%s', appId);

    var location = data.location.toLowerCase(),
        domain = data.domain.toLowerCase(),
        portBindings = data.portBindings || null,
        backupId = data.backupId,
        mailboxName = data.mailboxName || '';

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

            const manifest = backupInfo.manifest;

            // re-validate because this new box version may not accept old configs
            error = checkManifestConstraints(manifest);
            if (error) return callback(error);

            error = validatePortBindings(portBindings, manifest);
            if (error) return callback(error);

            if (mailboxName) {
                error = mail.validateName(mailboxName);
                if (error) return callback(error);
            } else {
                mailboxName = mailboxNameForLocation(location, manifest);
            }

            domains.get(domain, function (error, domainObject) {
                if (error && error.reason === DomainsError.NOT_FOUND) return callback(new AppsError(AppsError.EXTERNAL_ERROR, 'No such domain'));
                if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, 'Could not get domain info:' + error.message));

                error = domains.validateHostname(location, domainObject);
                if (error) return callback(new AppsError(AppsError.BAD_FIELD, 'Bad location: ' + error.message));

                var newAppId = uuid.v4();

                var data = {
                    installationState: appdb.ISTATE_PENDING_CLONE,
                    memoryLimit: app.memoryLimit,
                    accessRestriction: app.accessRestriction,
                    restoreConfig: { backupId: backupId, backupFormat: backupInfo.format },
                    sso: !!app.sso,
                    mailboxName: mailboxName,
                    enableBackup: app.enableBackup,
                    robotsTxt: app.robotsTxt,
                    env: app.env
                };

                appdb.add(newAppId, app.appStoreId, manifest, location, domain, translatePortBindings(portBindings, manifest), data, function (error) {
                    if (error && error.reason === DatabaseError.ALREADY_EXISTS) return callback(getDuplicateErrorDetails(error, location, domainObject, portBindings, []));
                    if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

                    purchaseApp({ appId: newAppId, appstoreId: app.appStoreId, manifestId: manifest.id }, function (error) {
                        if (error) return callback(error);

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

        appstore.unpurchaseApp(appId, { appstoreId: app.appStoreId, manifestId: app.manifest.id }, function (error) {
            if (error && error.reason === AppstoreError.NOT_FOUND) return callback(new AppsError(AppsError.NOT_FOUND));
            if (error && error.reason === AppstoreError.INVALID_TOKEN) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));
            if (error && error.reason === AppstoreError.LICENSE_ERROR) return callback(new AppsError(AppsError.EXTERNAL_ERROR, error.message));
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

    if (manifest.manifestVersion > 2) return new AppsError(AppsError.BAD_FIELD, 'Manifest version must be <= 2');

    if (!manifest.dockerImage) return new AppsError(AppsError.BAD_FIELD, 'Missing dockerImage'); // dockerImage is optional in manifest

    if (semver.valid(manifest.maxBoxVersion) && semver.gt(constants.VERSION, manifest.maxBoxVersion)) {
        return new AppsError(AppsError.BAD_FIELD, 'Box version exceeds Apps maxBoxVersion');
    }

    if (semver.valid(manifest.minBoxVersion) && semver.gt(manifest.minBoxVersion, constants.VERSION)) {
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
            if (error && error.statusCode === 409) return callback(new AppsError(AppsError.BAD_STATE, error.message)); // container restarting/not running

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
                    // there is a race where resizing too early results in a 404 "no such exec"
                    // https://git.cloudron.io/cloudron/box/issues/549
                    setTimeout(function () {
                        exec.resize({ h: options.rows, w: options.columns }, function (error) { if (error) debug('Error resizing console', error); });
                    }, 2000);
                }

                return callback(null, stream);
            });
        });
    });
}

function canAutoupdateApp(app, newManifest) {
    if (!app.enableAutomaticUpdate) return new Error('Automatic update disabled');
    if ((semver.major(app.manifest.version) !== 0) && (semver.major(app.manifest.version) !== semver.major(newManifest.version))) return new Error('Major version change'); // major changes are blocking

    const newTcpPorts = newManifest.tcpPorts || { };
    const newUdpPorts = newManifest.udpPorts || { };
    const portBindings = app.portBindings; // this is never null

    for (let portName in portBindings) {
        if (!(portName in newTcpPorts) && !(portName in newUdpPorts)) return new Error(`${portName} was in use but new update removes it`);
    }

    // it's fine if one or more (unused) keys got removed
    return null;
}

function autoupdateApps(updateInfo, auditSource, callback) { // updateInfo is { appId -> { manifest } }
    assert.strictEqual(typeof updateInfo, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

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

    getAll(function (error, apps) {
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

        async.map(apps, function (app, iteratorDone) {
            backups.getByAppIdPaged(1, 1, app.id, function (error, results) {
                var restoreConfig = !error && results.length ? { backupId: results[0].id, backupFormat: results[0].format } : null;

                debug(`marking ${app.fqdn} for restore using restore config ${JSON.stringify(restoreConfig)}`);

                appdb.setInstallationCommand(app.id, appdb.ISTATE_PENDING_RESTORE, { restoreConfig: restoreConfig, oldConfig: getAppConfig(app) }, function (error) {
                    if (error) debug(`Error marking ${app.fqdn} for restore: ${JSON.stringify(error)}`);

                    iteratorDone(); // always succeed
                });
            });
        }, callback);
    });
}

function configureInstalledApps(callback) {
    assert.strictEqual(typeof callback, 'function');

    getAll(function (error, apps) {
        if (error) return callback(new AppsError(AppsError.INTERNAL_ERROR, error));

        async.map(apps, function (app, iteratorDone) {
            debug(`marking ${app.fqdn} for reconfigure`);

            appdb.setInstallationCommand(app.id, appdb.ISTATE_PENDING_CONFIGURE, { oldConfig: null }, function (error) {
                if (error) debug(`Error marking ${app.fqdn} for reconfigure: ${JSON.stringify(error)}`);

                iteratorDone(); // always succeed
            });
        }, callback);
    });
}

function downloadFile(appId, filePath, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof filePath, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`downloadFile: ${filePath}`); // no need to escape filePath because we don't rely on bash
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

                        for (;;) {
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

    const done = once(function (error) {
        safe.fs.unlinkSync(sourceFilePath); // remove file in /tmp
        callback(error);
    });

    // the built-in bash printf understands "%q" but not /usr/bin/printf.
    // ' gets replaced with '\'' . the first closes the quote and last one starts a new one
    const escapedDestFilePath = safe.child_process.execSync(`printf %q '${destFilePath.replace(/'/g, '\'\\\'\'')}'`, { shell: '/bin/bash', encoding: 'utf8' });
    debug(`uploadFile: ${sourceFilePath} -> ${escapedDestFilePath}`);

    exec(appId, { cmd: [ 'bash', '-c', `cat - > ${escapedDestFilePath}` ], tty: false }, function (error, stream) {
        if (error) return done(error);

        var readFile = fs.createReadStream(sourceFilePath);
        readFile.on('error', done);

        stream.on('error', done);
        stream.on('finish', done);

        readFile.pipe(stream);
    });
}
