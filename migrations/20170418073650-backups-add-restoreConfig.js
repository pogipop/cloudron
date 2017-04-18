'use strict';

var async = require('async');

// from apps.js DO NOT UPDATE WHEN apps.js changes, as this is part of db migration!!
function postProcess(result) {
    try {
        result.manifest = JSON.parse(result.manifestJson);
        delete result.manifestJson;

        result.oldConfig = JSON.parse(result.oldConfigJson);
        delete result.oldConfigJson;

        result.portBindings = { };
        var hostPorts = result.hostPorts === null ? [ ] : result.hostPorts.split(',');
        var environmentVariables = result.environmentVariables === null ? [ ] : result.environmentVariables.split(',');

        delete result.hostPorts;
        delete result.environmentVariables;

        for (var i = 0; i < environmentVariables.length; i++) {
            result.portBindings[environmentVariables[i]] = parseInt(hostPorts[i], 10);
        }

        result.accessRestriction = JSON.parse(result.accessRestrictionJson);
        if (result.accessRestriction && !result.accessRestriction.users) result.accessRestriction.users = [];
        delete result.accessRestrictionJson;

        // TODO remove later once all apps have this attribute
        result.xFrameOptions = result.xFrameOptions || 'SAMEORIGIN';

        result.sso = !!result.sso; // make it bool

        result.debugMode = JSON.parse(result.debugModeJson);
        delete result.debugModeJson;
    } catch (e) {
        console.error('Failed to get restoreConfig for app.', e);
        console.error('Falling back to empty values to make the update succeed.');
        result.manifest = null;
    }
}

// from apps.js DO NOT UPDATE WHEN apps.js changes, as this is part of db migration!!
var APPS_FIELDS_PREFIXED = [ 'apps.id', 'apps.appStoreId', 'apps.installationState', 'apps.installationProgress', 'apps.runState',
    'apps.health', 'apps.containerId', 'apps.manifestJson', 'apps.httpPort', 'apps.location', 'apps.dnsRecordId',
    'apps.accessRestrictionJson', 'apps.lastBackupId', 'apps.oldConfigJson', 'apps.memoryLimit', 'apps.altDomain',
    'apps.xFrameOptions', 'apps.sso', 'apps.debugModeJson' ].join(',');

exports.up = function(db, callback) {
    async.series([
        db.runSql.bind(db, 'ALTER TABLE backups ADD COLUMN restoreConfig TEXT'),
        // fill all the backups with restoreConfigs from current apps
        function addRestoreConfigs(callback) {
            console.log('Importing restoreConfigs');

            var appQuery = 'SELECT ' + APPS_FIELDS_PREFIXED + ',' +
                'GROUP_CONCAT(CAST(appPortBindings.hostPort AS CHAR(6))) AS hostPorts, GROUP_CONCAT(appPortBindings.environmentVariable) AS environmentVariables' +
                ' FROM apps LEFT OUTER JOIN appPortBindings ON apps.id = appPortBindings.appId' +
                ' GROUP BY apps.id ORDER BY apps.id';

            db.all(appQuery, function (error, apps) {
                if (error) return callback(error);

                apps.forEach(postProcess);

                async.eachSeries(apps, function (app, next) {
                    if (app.manifest === null) return next();

                    db.all('SELECT * FROM backups WHERE type="app" AND id LIKE "%app%\\_' + app.id + '\\_%"', function (error, backups) {
                        if (error) return next(error);

                        // from apps.js:getAppConfig()
                        var restoreConfig = {
                            manifest: app.manifest,
                            location: app.location,
                            accessRestriction: app.accessRestriction,
                            portBindings: app.portBindings,
                            memoryLimit: app.memoryLimit,
                            xFrameOptions: app.xFrameOptions || 'SAMEORIGIN',
                            altDomain: app.altDomain
                        };

                        async.eachSeries(backups, function (backup, next) {
                            db.runSql('UPDATE backups SET restoreConfig=? WHERE id=?', [ JSON.stringify(restoreConfig), backup.id ], next);
                        }, next);
                    });
                }, callback);
            });
        }
    ], callback);
};

exports.down = function(db, callback) {
    db.runSql('ALTER TABLE backups DROP COLUMN restoreConfig', callback);
};
