'use strict';

exports = module.exports = {
    get: get,
    getByHttpPort: getByHttpPort,
    getByContainerId: getByContainerId,
    add: add,
    exists: exists,
    del: del,
    update: update,
    getAll: getAll,
    getPortBindings: getPortBindings,
    delPortBinding: delPortBinding,

    setAddonConfig: setAddonConfig,
    getAddonConfig: getAddonConfig,
    getAddonConfigByAppId: getAddonConfigByAppId,
    getAddonConfigByName: getAddonConfigByName,
    unsetAddonConfig: unsetAddonConfig,
    unsetAddonConfigByAppId: unsetAddonConfigByAppId,

    setHealth: setHealth,
    setInstallationCommand: setInstallationCommand,
    setRunCommand: setRunCommand,
    getAppStoreIds: getAppStoreIds,

    // installation codes (keep in sync in UI)
    ISTATE_PENDING_INSTALL: 'pending_install', // installs and fresh reinstalls
    ISTATE_PENDING_CLONE: 'pending_clone', // clone
    ISTATE_PENDING_CONFIGURE: 'pending_configure', // config (location, port) changes and on infra update
    ISTATE_PENDING_UNINSTALL: 'pending_uninstall', // uninstallation
    ISTATE_PENDING_RESTORE: 'pending_restore', // restore to previous backup or on upgrade
    ISTATE_PENDING_UPDATE: 'pending_update', // update from installed state preserving data
    ISTATE_PENDING_FORCE_UPDATE: 'pending_force_update', // update from any state preserving data
    ISTATE_PENDING_BACKUP: 'pending_backup', // backup the app
    ISTATE_ERROR: 'error', // error executing last pending_* command
    ISTATE_INSTALLED: 'installed', // app is installed

    RSTATE_RUNNING: 'running',
    RSTATE_PENDING_START: 'pending_start',
    RSTATE_PENDING_STOP: 'pending_stop',
    RSTATE_STOPPED: 'stopped', // app stopped by use

    // run codes (keep in sync in UI)
    HEALTH_HEALTHY: 'healthy',
    HEALTH_UNHEALTHY: 'unhealthy',
    HEALTH_ERROR: 'error',
    HEALTH_DEAD: 'dead',

    _clear: clear
};

var assert = require('assert'),
    async = require('async'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror'),
    mailboxdb = require('./mailboxdb.js'),
    safe = require('safetydance'),
    util = require('util');

var APPS_FIELDS_PREFIXED = [ 'apps.id', 'apps.appStoreId', 'apps.installationState', 'apps.installationProgress', 'apps.runState',
    'apps.health', 'apps.containerId', 'apps.manifestJson', 'apps.httpPort', 'apps.location', 'apps.dnsRecordId',
    'apps.accessRestrictionJson', 'apps.lastBackupId', 'apps.oldConfigJson', 'apps.updateConfigJson', 'apps.memoryLimit', 'apps.altDomain',
    'apps.xFrameOptions', 'apps.sso', 'apps.debugModeJson', 'apps.robotsTxt', 'apps.enableBackup' ].join(',');

var PORT_BINDINGS_FIELDS = [ 'hostPort', 'environmentVariable', 'appId' ].join(',');

function postProcess(result) {
    assert.strictEqual(typeof result, 'object');

    assert(result.manifestJson === null || typeof result.manifestJson === 'string');
    result.manifest = safe.JSON.parse(result.manifestJson);
    delete result.manifestJson;

    assert(result.oldConfigJson === null || typeof result.oldConfigJson === 'string');
    result.oldConfig = safe.JSON.parse(result.oldConfigJson);
    delete result.oldConfigJson;

    assert(result.updateConfigJson === null || typeof result.updateConfigJson === 'string');
    result.updateConfig = safe.JSON.parse(result.updateConfigJson);
    delete result.updateConfigJson;

    assert(result.hostPorts === null || typeof result.hostPorts === 'string');
    assert(result.environmentVariables === null || typeof result.environmentVariables === 'string');

    result.portBindings = { };
    var hostPorts = result.hostPorts === null ? [ ] : result.hostPorts.split(',');
    var environmentVariables = result.environmentVariables === null ? [ ] : result.environmentVariables.split(',');

    delete result.hostPorts;
    delete result.environmentVariables;

    for (var i = 0; i < environmentVariables.length; i++) {
        result.portBindings[environmentVariables[i]] = parseInt(hostPorts[i], 10);
    }

    assert(result.accessRestrictionJson === null || typeof result.accessRestrictionJson === 'string');
    result.accessRestriction = safe.JSON.parse(result.accessRestrictionJson);
    if (result.accessRestriction && !result.accessRestriction.users) result.accessRestriction.users = [];
    delete result.accessRestrictionJson;

    // TODO remove later once all apps have this attribute
    result.xFrameOptions = result.xFrameOptions || 'SAMEORIGIN';

    result.sso = !!result.sso; // make it bool
    result.enableBackup = !!result.enableBackup; // make it bool

    assert(result.debugModeJson === null || typeof result.debugModeJson === 'string');
    result.debugMode = safe.JSON.parse(result.debugModeJson);
    delete result.debugModeJson;
}

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + APPS_FIELDS_PREFIXED + ','
        + 'GROUP_CONCAT(CAST(appPortBindings.hostPort AS CHAR(6))) AS hostPorts, GROUP_CONCAT(appPortBindings.environmentVariable) AS environmentVariables'
        + ' FROM apps LEFT OUTER JOIN appPortBindings ON apps.id = appPortBindings.appId WHERE apps.id = ? GROUP BY apps.id', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        postProcess(result[0]);

        callback(null, result[0]);
    });
}

function getByHttpPort(httpPort, callback) {
    assert.strictEqual(typeof httpPort, 'number');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + APPS_FIELDS_PREFIXED + ','
        + 'GROUP_CONCAT(CAST(appPortBindings.hostPort AS CHAR(6))) AS hostPorts, GROUP_CONCAT(appPortBindings.environmentVariable) AS environmentVariables'
        + '  FROM apps LEFT OUTER JOIN appPortBindings ON apps.id = appPortBindings.appId WHERE httpPort = ? GROUP BY apps.id', [ httpPort ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        postProcess(result[0]);

        callback(null, result[0]);
    });
}

function getByContainerId(containerId, callback) {
    assert.strictEqual(typeof containerId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + APPS_FIELDS_PREFIXED + ','
        + 'GROUP_CONCAT(CAST(appPortBindings.hostPort AS CHAR(6))) AS hostPorts, GROUP_CONCAT(appPortBindings.environmentVariable) AS environmentVariables'
        + '  FROM apps LEFT OUTER JOIN appPortBindings ON apps.id = appPortBindings.appId WHERE containerId = ? GROUP BY apps.id', [ containerId ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        postProcess(result[0]);

        callback(null, result[0]);
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + APPS_FIELDS_PREFIXED + ','
        + 'GROUP_CONCAT(CAST(appPortBindings.hostPort AS CHAR(6))) AS hostPorts, GROUP_CONCAT(appPortBindings.environmentVariable) AS environmentVariables'
        + ' FROM apps LEFT OUTER JOIN appPortBindings ON apps.id = appPortBindings.appId'
        + ' GROUP BY apps.id ORDER BY apps.id', function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        results.forEach(postProcess);

        callback(null, results);
    });
}

function add(id, appStoreId, manifest, location, portBindings, data, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof appStoreId, 'string');
    assert(manifest && typeof manifest === 'object');
    assert.strictEqual(typeof manifest.version, 'string');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof portBindings, 'object');
    assert(data && typeof data === 'object');
    assert.strictEqual(typeof callback, 'function');

    portBindings = portBindings || { };

    var manifestJson = JSON.stringify(manifest);

    var accessRestriction = data.accessRestriction || null;
    var accessRestrictionJson = JSON.stringify(accessRestriction);
    var memoryLimit = data.memoryLimit || 0;
    var altDomain = data.altDomain || null;
    var xFrameOptions = data.xFrameOptions || '';
    var installationState = data.installationState || exports.ISTATE_PENDING_INSTALL;
    var lastBackupId = data.lastBackupId || null; // used when cloning
    var sso = 'sso' in data ? data.sso : null;
    var debugModeJson = data.debugMode ? JSON.stringify(data.debugMode) : null;

    var queries = [];
    queries.push({
        query: 'INSERT INTO apps (id, appStoreId, manifestJson, installationState, location, accessRestrictionJson, memoryLimit, altDomain, xFrameOptions, lastBackupId, sso, debugModeJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [ id, appStoreId, manifestJson, installationState, location, accessRestrictionJson, memoryLimit, altDomain, xFrameOptions, lastBackupId, sso, debugModeJson ]
    });

    Object.keys(portBindings).forEach(function (env) {
        queries.push({
            query: 'INSERT INTO appPortBindings (environmentVariable, hostPort, appId) VALUES (?, ?, ?)',
            args: [ env, portBindings[env], id ]
        });
    });

    // only allocate a mailbox if mailboxName is set
    if (data.mailboxName) {
        queries.push({
            query: 'INSERT INTO mailboxes (name, ownerId, ownerType) VALUES (?, ?, ?)',
            args: [ data.mailboxName, id, mailboxdb.TYPE_APP ]
        });
    }

    database.transaction(queries, function (error) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, error.message));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function exists(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT 1 FROM apps WHERE id=?', [ id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        return callback(null, result.length !== 0);
    });
}

function getPortBindings(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + PORT_BINDINGS_FIELDS + ' FROM appPortBindings WHERE appId = ?', [ id ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        var portBindings = { };
        for (var i = 0; i < results.length; i++) {
            portBindings[results[i].environmentVariable] = results[i].hostPort;
        }

        callback(null, portBindings);
    });
}

function delPortBinding(hostPort, callback) {
    assert.strictEqual(typeof hostPort, 'number');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM appPortBindings WHERE hostPort=?', [ hostPort ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function del(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    var queries = [
        { query: 'DELETE FROM mailboxes WHERE ownerId=?', args: [ id ] },
        { query: 'DELETE FROM appPortBindings WHERE appId = ?', args: [ id ] },
        { query: 'DELETE FROM apps WHERE id = ?', args: [ id ] }
    ];

    database.transaction(queries, function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results[2].affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function clear(callback) {
    assert.strictEqual(typeof callback, 'function');

    async.series([
        database.query.bind(null, 'DELETE FROM appPortBindings'),
        database.query.bind(null, 'DELETE FROM appAddonConfigs'),
        database.query.bind(null, 'DELETE FROM apps')
    ], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        return callback(null);
    });
}

function update(id, app, callback) {
    updateWithConstraints(id, app, '', callback);
}

function updateWithConstraints(id, app, constraints, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof constraints, 'string');
    assert.strictEqual(typeof callback, 'function');
    assert(!('portBindings' in app) || typeof app.portBindings === 'object');
    assert(!('accessRestriction' in app) || typeof app.accessRestriction === 'object' || app.accessRestriction === '');

    var queries = [ ];

    if ('portBindings' in app) {
        var portBindings = app.portBindings || { };
        // replace entries by app id
        queries.push({ query: 'DELETE FROM appPortBindings WHERE appId = ?', args: [ id ] });
        Object.keys(portBindings).forEach(function (env) {
            var values = [ portBindings[env], env, id ];
            queries.push({ query: 'INSERT INTO appPortBindings (hostPort, environmentVariable, appId) VALUES(?, ?, ?)', args: values });
        });
    }

    var fields = [ ], values = [ ];
    for (var p in app) {
        if (p === 'manifest' || p === 'oldConfig' || p === 'updateConfig' || p === 'accessRestriction' || p === 'debugMode') {
            fields.push(`${p}Json = ?`);
            values.push(JSON.stringify(app[p]));
        } else if (p !== 'portBindings') {
            fields.push(p + ' = ?');
            values.push(app[p]);
        }
    }

    if (values.length !== 0) {
        values.push(id);
        queries.push({ query: 'UPDATE apps SET ' + fields.join(', ') + ' WHERE id = ? ' + constraints, args: values });
    }

    database.transaction(queries, function (error, results) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, error.message));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results[results.length - 1].affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        return callback(null);
    });
}

// not sure if health should influence runState
function setHealth(appId, health, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof health, 'string');
    assert.strictEqual(typeof callback, 'function');

    var values = { health: health };

    var constraints = 'AND runState NOT LIKE "pending_%" AND installationState = "installed"';

    updateWithConstraints(appId, values, constraints, callback);
}

function setInstallationCommand(appId, installationState, values, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof installationState, 'string');

    if (typeof values === 'function') {
        callback = values;
        values = { };
    } else {
        assert.strictEqual(typeof values, 'object');
        assert.strictEqual(typeof callback, 'function');
    }

    values.installationState = installationState;
    values.installationProgress = '';

    // Rules are:
    // uninstall is allowed in any state
    // force update is allowed in any state including pending_uninstall! (for better or worse)
    // restore is allowed from installed or error state or currently restoring
    // configure is allowed in installed state or currently configuring or in error state
    // update and backup are allowed only in installed state

    if (installationState === exports.ISTATE_PENDING_UNINSTALL || installationState === exports.ISTATE_PENDING_FORCE_UPDATE) {
        updateWithConstraints(appId, values, '', callback);
    } else if (installationState === exports.ISTATE_PENDING_RESTORE) {
        updateWithConstraints(appId, values, 'AND (installationState = "installed" OR installationState = "error" OR installationState = "pending_restore")', callback);
    } else if (installationState === exports.ISTATE_PENDING_UPDATE || installationState === exports.ISTATE_PENDING_BACKUP) {
        updateWithConstraints(appId, values, 'AND installationState = "installed"', callback);
    } else if (installationState === exports.ISTATE_PENDING_CONFIGURE) {
        updateWithConstraints(appId, values, 'AND (installationState = "installed" OR installationState = "pending_configure" OR installationState = "error")', callback);
    } else {
        callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, 'invalid installationState'));
    }
}

function setRunCommand(appId, runState, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof runState, 'string');
    assert.strictEqual(typeof callback, 'function');

    var values = { runState: runState };
    updateWithConstraints(appId, values, 'AND runState NOT LIKE "pending_%" AND installationState = "installed"', callback);
}

function getAppStoreIds(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT id, appStoreId FROM apps', function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null, results);
    });
}

function setAddonConfig(appId, addonId, env, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof addonId, 'string');
    assert(util.isArray(env));
    assert.strictEqual(typeof callback, 'function');

    unsetAddonConfig(appId, addonId, function (error) {
        if (error) return callback(error);

        if (env.length === 0) return callback(null);

        var query = 'INSERT INTO appAddonConfigs(appId, addonId, name, value) VALUES ';
        var args = [ ], queryArgs = [ ];
        for (var i = 0; i < env.length; i++) {
            args.push(appId, addonId, env[i].name, env[i].value);
            queryArgs.push('(?, ?, ?, ?)');
        }

        database.query(query + queryArgs.join(','), args, function (error) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            return callback(null);
        });
    });
}

function unsetAddonConfig(appId, addonId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof addonId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM appAddonConfigs WHERE appId = ? AND addonId = ?', [ appId, addonId ], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function unsetAddonConfigByAppId(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM appAddonConfigs WHERE appId = ?', [ appId ], function (error) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}

function getAddonConfig(appId, addonId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof addonId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT name, value FROM appAddonConfigs WHERE appId = ? AND addonId = ?', [ appId, addonId ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null, results);
    });
}

function getAddonConfigByAppId(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT name, value FROM appAddonConfigs WHERE appId = ?', [ appId ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null, results);
    });
}

function getAddonConfigByName(appId, addonId, name, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof addonId, 'string');
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT value FROM appAddonConfigs WHERE appId = ? AND addonId = ? AND name = ?', [ appId, addonId, name ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, results[0].value);
    });
}
