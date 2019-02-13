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
    getAppIdByAddonConfigValue: getAppIdByAddonConfigValue,

    setHealth: setHealth,
    setInstallationCommand: setInstallationCommand,
    setRunCommand: setRunCommand,
    getAppStoreIds: getAppStoreIds,

    setOwner: setOwner,
    transferOwnership: transferOwnership,

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
    RSTATE_STOPPED: 'stopped', // app stopped by us

    // run codes (keep in sync in UI)
    HEALTH_HEALTHY: 'healthy',
    HEALTH_UNHEALTHY: 'unhealthy',
    HEALTH_ERROR: 'error',
    HEALTH_DEAD: 'dead',

    // subdomain table types
    SUBDOMAIN_TYPE_PRIMARY: 'primary',
    SUBDOMAIN_TYPE_REDIRECT: 'redirect',

    _clear: clear
};

var assert = require('assert'),
    async = require('async'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror'),
    safe = require('safetydance'),
    util = require('util');

var APPS_FIELDS_PREFIXED = [ 'apps.id', 'apps.appStoreId', 'apps.installationState', 'apps.installationProgress', 'apps.runState',
    'apps.health', 'apps.containerId', 'apps.manifestJson', 'apps.httpPort', 'subdomains.subdomain AS location', 'subdomains.domain',
    'apps.accessRestrictionJson', 'apps.restoreConfigJson', 'apps.oldConfigJson', 'apps.updateConfigJson', 'apps.memoryLimit',
    'apps.xFrameOptions', 'apps.sso', 'apps.debugModeJson', 'apps.robotsTxt', 'apps.enableBackup',
    'apps.creationTime', 'apps.updateTime', 'apps.ownerId', 'apps.mailboxName', 'apps.enableAutomaticUpdate',
    'apps.dataDir', 'apps.ts', 'apps.healthTime' ].join(',');

var PORT_BINDINGS_FIELDS = [ 'hostPort', 'type', 'environmentVariable', 'appId' ].join(',');

const SUBDOMAIN_FIELDS = [ 'appId', 'domain', 'subdomain', 'type' ].join(',');

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

    assert(result.restoreConfigJson === null || typeof result.restoreConfigJson === 'string');
    result.restoreConfig = safe.JSON.parse(result.restoreConfigJson);
    delete result.restoreConfigJson;

    assert(result.hostPorts === null || typeof result.hostPorts === 'string');
    assert(result.environmentVariables === null || typeof result.environmentVariables === 'string');

    result.portBindings = { };
    let hostPorts = result.hostPorts === null ? [ ] : result.hostPorts.split(',');
    let environmentVariables = result.environmentVariables === null ? [ ] : result.environmentVariables.split(',');
    let portTypes = result.portTypes === null ? [ ] : result.portTypes.split(',');

    delete result.hostPorts;
    delete result.environmentVariables;
    delete result.portTypes;

    for (let i = 0; i < environmentVariables.length; i++) {
        result.portBindings[environmentVariables[i]] = { hostPort: parseInt(hostPorts[i], 10), type: portTypes[i] };
    }

    assert(result.accessRestrictionJson === null || typeof result.accessRestrictionJson === 'string');
    result.accessRestriction = safe.JSON.parse(result.accessRestrictionJson);
    if (result.accessRestriction && !result.accessRestriction.users) result.accessRestriction.users = [];
    delete result.accessRestrictionJson;

    // TODO remove later once all apps have this attribute
    result.xFrameOptions = result.xFrameOptions || 'SAMEORIGIN';

    result.sso = !!result.sso; // make it bool
    result.enableBackup = !!result.enableBackup; // make it bool
    result.enableAutomaticUpdate = !!result.enableAutomaticUpdate; // make it bool

    assert(result.debugModeJson === null || typeof result.debugModeJson === 'string');
    result.debugMode = safe.JSON.parse(result.debugModeJson);
    delete result.debugModeJson;

    result.alternateDomains = result.alternateDomains || [];
    result.alternateDomains.forEach(function (d) {
        delete d.appId;
        delete d.type;
    });

    let envNames = JSON.parse(result.envNames), envValues = JSON.parse(result.envValues);
    delete result.envNames;
    delete result.envValues;
    result.env = {};
    for (let i = 0; i < envNames.length; i++) { // NOTE: envNames is [ null ] when env of an app is empty
        if (envNames[i]) result.env[envNames[i]] = envValues[i];
    }

    // in the db, we store dataDir as unique/nullable
    result.dataDir = result.dataDir || '';
}

function get(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + APPS_FIELDS_PREFIXED + ','
        + 'GROUP_CONCAT(CAST(appPortBindings.hostPort AS CHAR(6))) AS hostPorts, GROUP_CONCAT(appPortBindings.environmentVariable) AS environmentVariables, GROUP_CONCAT(appPortBindings.type) AS portTypes, '
        + 'JSON_ARRAYAGG(appEnvVars.name) AS envNames, JSON_ARRAYAGG(appEnvVars.value) AS envValues'
        + ' FROM apps'
        + '  LEFT OUTER JOIN appPortBindings ON apps.id = appPortBindings.appId'
        + '  LEFT OUTER JOIN appEnvVars ON apps.id = appEnvVars.appId'
        + '  LEFT OUTER JOIN subdomains ON apps.id = subdomains.appId AND subdomains.type = ?'
        + ' WHERE apps.id = ? GROUP BY apps.id', [ exports.SUBDOMAIN_TYPE_PRIMARY, id ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        database.query('SELECT ' + SUBDOMAIN_FIELDS + ' FROM subdomains WHERE appId = ? AND type = ?', [ id, exports.SUBDOMAIN_TYPE_REDIRECT ], function (error, alternateDomains) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            result[0].alternateDomains = alternateDomains;

            postProcess(result[0]);

            callback(null, result[0]);
        });
    });
}

function getByHttpPort(httpPort, callback) {
    assert.strictEqual(typeof httpPort, 'number');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + APPS_FIELDS_PREFIXED + ','
    + 'GROUP_CONCAT(CAST(appPortBindings.hostPort AS CHAR(6))) AS hostPorts, GROUP_CONCAT(appPortBindings.environmentVariable) AS environmentVariables, GROUP_CONCAT(appPortBindings.type) AS portTypes,'
    + 'JSON_ARRAYAGG(appEnvVars.name) AS envNames, JSON_ARRAYAGG(appEnvVars.value) AS envValues'
        + ' FROM apps'
        + '  LEFT OUTER JOIN appPortBindings ON apps.id = appPortBindings.appId'
        + '  LEFT OUTER JOIN appEnvVars ON apps.id = appEnvVars.appId'
        + '  LEFT OUTER JOIN subdomains ON apps.id = subdomains.appId AND subdomains.type = ?'
        + ' WHERE httpPort = ? GROUP BY apps.id', [ exports.SUBDOMAIN_TYPE_PRIMARY, httpPort ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        database.query('SELECT ' + SUBDOMAIN_FIELDS + ' FROM subdomains WHERE appId = ? AND type = ?', [ result[0].id, exports.SUBDOMAIN_TYPE_REDIRECT ], function (error, alternateDomains) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            result[0].alternateDomains = alternateDomains;
            postProcess(result[0]);

            callback(null, result[0]);
        });
    });
}

function getByContainerId(containerId, callback) {
    assert.strictEqual(typeof containerId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + APPS_FIELDS_PREFIXED + ','
        + 'GROUP_CONCAT(CAST(appPortBindings.hostPort AS CHAR(6))) AS hostPorts, GROUP_CONCAT(appPortBindings.environmentVariable) AS environmentVariables, GROUP_CONCAT(appPortBindings.type) AS portTypes,'
        + 'JSON_ARRAYAGG(appEnvVars.name) AS envNames, JSON_ARRAYAGG(appEnvVars.value) AS envValues'
        + ' FROM apps'
        + '  LEFT OUTER JOIN appPortBindings ON apps.id = appPortBindings.appId'
        + '  LEFT OUTER JOIN appEnvVars ON apps.id = appEnvVars.appId'
        + '  LEFT OUTER JOIN subdomains ON apps.id = subdomains.appId AND subdomains.type = ?'
        + ' WHERE containerId = ? GROUP BY apps.id', [ exports.SUBDOMAIN_TYPE_PRIMARY, containerId ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        database.query('SELECT ' + SUBDOMAIN_FIELDS + ' FROM subdomains WHERE appId = ? AND type = ?', [ result[0].id, exports.SUBDOMAIN_TYPE_REDIRECT ], function (error, alternateDomains) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            result[0].alternateDomains = alternateDomains;
            postProcess(result[0]);

            callback(null, result[0]);
        });
    });
}

function getAll(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT ' + APPS_FIELDS_PREFIXED + ','
        + 'GROUP_CONCAT(CAST(appPortBindings.hostPort AS CHAR(6))) AS hostPorts, GROUP_CONCAT(appPortBindings.environmentVariable) AS environmentVariables, GROUP_CONCAT(appPortBindings.type) AS portTypes,'
        + 'JSON_ARRAYAGG(appEnvVars.name) AS envNames, JSON_ARRAYAGG(appEnvVars.value) AS envValues'
        + ' FROM apps'
        + '  LEFT OUTER JOIN appPortBindings ON apps.id = appPortBindings.appId'
        + '  LEFT OUTER JOIN appEnvVars ON apps.id = appEnvVars.appId'
        + '  LEFT OUTER JOIN subdomains ON apps.id = subdomains.appId AND subdomains.type = ?'
        + ' GROUP BY apps.id ORDER BY apps.id', [ exports.SUBDOMAIN_TYPE_PRIMARY ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        database.query('SELECT ' + SUBDOMAIN_FIELDS + ' FROM subdomains WHERE type = ?', [ exports.SUBDOMAIN_TYPE_REDIRECT ], function (error, alternateDomains) {
            if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

            alternateDomains.forEach(function (d) {
                var domain = results.find(function (a) { return d.appId === a.id; });
                if (!domain) return;

                domain.alternateDomains = domain.alternateDomains || [];
                domain.alternateDomains.push(d);
            });

            results.forEach(postProcess);

            callback(null, results);
        });
    });
}

function add(id, appStoreId, manifest, location, domain, ownerId, portBindings, data, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof appStoreId, 'string');
    assert(manifest && typeof manifest === 'object');
    assert.strictEqual(typeof manifest.version, 'string');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof ownerId, 'string');
    assert.strictEqual(typeof portBindings, 'object');
    assert(data && typeof data === 'object');
    assert.strictEqual(typeof callback, 'function');

    portBindings = portBindings || { };

    var manifestJson = JSON.stringify(manifest);

    var accessRestriction = data.accessRestriction || null;
    var accessRestrictionJson = JSON.stringify(accessRestriction);
    var memoryLimit = data.memoryLimit || 0;
    var xFrameOptions = data.xFrameOptions || '';
    var installationState = data.installationState || exports.ISTATE_PENDING_INSTALL;
    var restoreConfigJson = data.restoreConfig ? JSON.stringify(data.restoreConfig) : null; // used when cloning
    var sso = 'sso' in data ? data.sso : null;
    var robotsTxt = 'robotsTxt' in data ? data.robotsTxt : null;
    var debugModeJson = data.debugMode ? JSON.stringify(data.debugMode) : null;
    var env = data.env || {};
    const mailboxName = data.mailboxName || null;

    var queries = [];

    queries.push({
        query: 'INSERT INTO apps (id, appStoreId, manifestJson, installationState, accessRestrictionJson, memoryLimit, xFrameOptions, restoreConfigJson, sso, debugModeJson, robotsTxt, ownerId, mailboxName) ' +
            ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [ id, appStoreId, manifestJson, installationState, accessRestrictionJson, memoryLimit, xFrameOptions, restoreConfigJson, sso, debugModeJson, robotsTxt, ownerId, mailboxName ]
    });

    queries.push({
        query: 'INSERT INTO subdomains (appId, domain, subdomain, type) VALUES (?, ?, ?, ?)',
        args: [ id, domain, location, exports.SUBDOMAIN_TYPE_PRIMARY ]
    });

    Object.keys(portBindings).forEach(function (env) {
        queries.push({
            query: 'INSERT INTO appPortBindings (environmentVariable, hostPort, type, appId) VALUES (?, ?, ?, ?)',
            args: [ env, portBindings[env].hostPort, portBindings[env].type, id ]
        });
    });

    Object.keys(env).forEach(function (name) {
        queries.push({
            query: 'INSERT INTO appEnvVars (appId, name, value) VALUES (?, ?, ?)',
            args: [ id, name, env[name] ]
        });
    });

    if (data.alternateDomains) {
        data.alternateDomains.forEach(function (d) {
            queries.push({
                query: 'INSERT INTO subdomains (appId, domain, subdomain, type) VALUES (?, ?, ?, ?)',
                args: [ id, d.domain, d.subdomain, exports.SUBDOMAIN_TYPE_REDIRECT ]
            });
        });
    }

    database.transaction(queries, function (error) {
        if (error && error.code === 'ER_DUP_ENTRY') return callback(new DatabaseError(DatabaseError.ALREADY_EXISTS, error.message));
        if (error && error.code === 'ER_NO_REFERENCED_ROW_2') return callback(new DatabaseError(DatabaseError.NOT_FOUND, 'no such domain'));
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
            portBindings[results[i].environmentVariable] = { hostPort: results[i].hostPort, type: results[i].type };
        }

        callback(null, portBindings);
    });
}

function delPortBinding(hostPort, type, callback) {
    assert.strictEqual(typeof hostPort, 'number');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('DELETE FROM appPortBindings WHERE hostPort=? AND type=?', [ hostPort, type ], function (error, result) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (result.affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function del(id, callback) {
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(typeof callback, 'function');

    var queries = [
        { query: 'DELETE FROM subdomains WHERE appId = ?', args: [ id ] },
        { query: 'DELETE FROM appPortBindings WHERE appId = ?', args: [ id ] },
        { query: 'DELETE FROM appEnvVars WHERE appId = ?', args: [ id ] },
        { query: 'DELETE FROM apps WHERE id = ?', args: [ id ] }
    ];

    database.transaction(queries, function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results[3].affectedRows !== 1) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null);
    });
}

function clear(callback) {
    assert.strictEqual(typeof callback, 'function');

    async.series([
        database.query.bind(null, 'DELETE FROM subdomains'),
        database.query.bind(null, 'DELETE FROM appPortBindings'),
        database.query.bind(null, 'DELETE FROM appAddonConfigs'),
        database.query.bind(null, 'DELETE FROM appEnvVars'),
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
    assert(!('alternateDomains' in app) || Array.isArray(app.alternateDomains));
    assert(!('env' in app) || typeof app.env === 'object');

    var queries = [ ];

    if ('portBindings' in app) {
        var portBindings = app.portBindings || { };
        // replace entries by app id
        queries.push({ query: 'DELETE FROM appPortBindings WHERE appId = ?', args: [ id ] });
        Object.keys(portBindings).forEach(function (env) {
            var values = [ portBindings[env].hostPort, portBindings[env].type, env, id ];
            queries.push({ query: 'INSERT INTO appPortBindings (hostPort, type, environmentVariable, appId) VALUES(?, ?, ?, ?)', args: values });
        });
    }

    if ('env' in app) {
        queries.push({ query: 'DELETE FROM appEnvVars WHERE appId = ?', args: [ id ] });

        Object.keys(app.env).forEach(function (name) {
            queries.push({
                query: 'INSERT INTO appEnvVars (appId, name, value) VALUES (?, ?, ?)',
                args: [ id, name, app.env[name] ]
            });
        });
    }

    if ('location' in app && 'domain' in app) { // must be updated together as they are unique together
        queries.push({ query: 'UPDATE subdomains SET subdomain = ?, domain = ? WHERE appId = ? AND type = ?', args: [ app.location, app.domain, id, exports.SUBDOMAIN_TYPE_PRIMARY ]});
    }

    if ('alternateDomains' in app) {
        queries.push({ query: 'DELETE FROM subdomains WHERE appId = ? AND type = ?', args: [ id, exports.SUBDOMAIN_TYPE_REDIRECT ]});
        app.alternateDomains.forEach(function (d) {
            queries.push({ query: 'INSERT INTO subdomains (appId, domain, subdomain, type) VALUES (?, ?, ?, ?)', args: [ id, d.domain, d.subdomain, exports.SUBDOMAIN_TYPE_REDIRECT ]});
        });
    }

    var fields = [ ], values = [ ];
    for (var p in app) {
        if (p === 'manifest' || p === 'oldConfig' || p === 'updateConfig' || p === 'restoreConfig' || p === 'accessRestriction' || p === 'debugMode') {
            fields.push(`${p}Json = ?`);
            values.push(JSON.stringify(app[p]));
        } else if (p !== 'portBindings' && p !== 'location' && p !== 'domain' && p !== 'alternateDomains' && p !== 'env') {
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
function setHealth(appId, health, healthTime, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof health, 'string');
    assert(util.isDate(healthTime));
    assert.strictEqual(typeof callback, 'function');

    var values = { health, healthTime };

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

function getAppIdByAddonConfigValue(addonId, name, value, callback) {
    assert.strictEqual(typeof addonId, 'string');
    assert.strictEqual(typeof name, 'string');
    assert.strictEqual(typeof value, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('SELECT appId FROM appAddonConfigs WHERE addonId = ? AND name = ? AND value = ?', [ addonId, name, value ], function (error, results) {
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));
        if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND));

        callback(null, results[0].appId);
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

function setOwner(appId, ownerId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof ownerId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('UPDATE apps SET ownerId=? WHERE appId=?', [ ownerId, appId ], function (error, results) {
        if (error && error.code === 'ER_NO_REFERENCED_ROW_2') return callback(new DatabaseError(DatabaseError.NOT_FOUND, 'No such user'));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        if (results.length === 0) return callback(new DatabaseError(DatabaseError.NOT_FOUND, 'No such app'));

        callback(null);
    });
}

function transferOwnership(oldOwnerId, newOwnerId, callback) {
    assert.strictEqual(typeof oldOwnerId, 'string');
    assert.strictEqual(typeof newOwnerId, 'string');
    assert.strictEqual(typeof callback, 'function');

    database.query('UPDATE apps SET ownerId=? WHERE ownerId=?', [ newOwnerId, oldOwnerId ], function (error) {
        if (error && error.code === 'ER_NO_REFERENCED_ROW_2') return callback(new DatabaseError(DatabaseError.NOT_FOUND, 'No such user'));
        if (error) return callback(new DatabaseError(DatabaseError.INTERNAL_ERROR, error));

        callback(null);
    });
}
