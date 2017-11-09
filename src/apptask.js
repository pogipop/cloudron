#!/usr/bin/env node

'use strict';

exports = module.exports = {
    initialize: initialize,
    startTask: startTask,

    // exported for testing
    _reserveHttpPort: reserveHttpPort,
    _configureNginx: configureNginx,
    _unconfigureNginx: unconfigureNginx,
    _createVolume: createVolume,
    _deleteVolume: deleteVolume,
    _verifyManifest: verifyManifest,
    _registerSubdomain: registerSubdomain,
    _unregisterSubdomain: unregisterSubdomain,
    _waitForDnsPropagation: waitForDnsPropagation,
    _waitForAltDomainDnsPropagation: waitForAltDomainDnsPropagation
};

require('supererror')({ splatchError: true });

// remove timestamp from debug() based output
require('debug').formatArgs = function formatArgs(args) {
    args[0] = this.namespace + ' ' + args[0];
};

var addons = require('./addons.js'),
    appdb = require('./appdb.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    backups = require('./backups.js'),
    certificates = require('./certificates.js'),
    config = require('./config.js'),
    database = require('./database.js'),
    DatabaseError = require('./databaseerror.js'),
    debug = require('debug')('box:apptask'),
    docker = require('./docker.js'),
    domains = require('./domains.js'),
    DomainError = domains.DomainError,
    ejs = require('ejs'),
    fs = require('fs'),
    manifestFormat = require('cloudron-manifestformat'),
    net = require('net'),
    nginx = require('./nginx.js'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    superagent = require('superagent'),
    sysinfo = require('./sysinfo.js'),
    tld = require('tldjs'),
    util = require('util'),
    _ = require('underscore');

var COLLECTD_CONFIG_EJS = fs.readFileSync(__dirname + '/collectd.config.ejs', { encoding: 'utf8' }),
    CONFIGURE_COLLECTD_CMD = path.join(__dirname, 'scripts/configurecollectd.sh'),
    LOGROTATE_CONFIG_EJS = fs.readFileSync(__dirname + '/logrotate.ejs', { encoding: 'utf8' }),
    CONFIGURE_LOGROTATE_CMD = path.join(__dirname, 'scripts/configurelogrotate.sh'),
    RMAPPDIR_CMD = path.join(__dirname, 'scripts/rmappdir.sh'),
    CREATEAPPDIR_CMD = path.join(__dirname, 'scripts/createappdir.sh');

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    database.initialize(callback);
}

function debugApp(app) {
    assert.strictEqual(typeof app, 'object');

    var prefix = app ? (config.appFqdn(app) || '(bare)') : '(no app)';
    debug(prefix + ' ' + util.format.apply(util, Array.prototype.slice.call(arguments, 1)));
}

function reserveHttpPort(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    var server = net.createServer();
    server.listen(0, function () {
        var port = server.address().port;
        updateApp(app, { httpPort: port }, function (error) {
            if (error) {
                server.close();
                return callback(error);
            }

            server.close(callback);
        });
    });
}

function configureNginx(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    certificates.ensureCertificate(app, function (error, certFilePath, keyFilePath) {
        if (error) return callback(error);

        nginx.configureApp(app, certFilePath, keyFilePath, callback);
    });
}

function unconfigureNginx(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    // TODO: maybe revoke the cert
    nginx.unconfigureApp(app, callback);
}

function createContainer(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');
    assert(!app.containerId); // otherwise, it will trigger volumeFrom

    debugApp(app, 'creating container');

    docker.createContainer(app, function (error, container) {
        if (error) return callback(new Error('Error creating container: ' + error));

        updateApp(app, { containerId: container.id }, callback);
    });
}

function deleteContainers(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'deleting app containers (app, scheduler)');

    docker.deleteContainers(app.id, function (error) {
        if (error) return callback(new Error('Error deleting container: ' + error));

        updateApp(app, { containerId: null }, callback);
    });
}

function createVolume(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    shell.sudo('createVolume', [ CREATEAPPDIR_CMD, app.id ], callback);
}

function deleteVolume(app, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    shell.sudo('deleteVolume', [ RMAPPDIR_CMD, app.id, !!options.removeDirectory ], callback);
}

function addCollectdProfile(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    var collectdConf = ejs.render(COLLECTD_CONFIG_EJS, { appId: app.id, containerId: app.containerId });
    fs.writeFile(path.join(paths.COLLECTD_APPCONFIG_DIR, app.id + '.conf'), collectdConf, function (error) {
        if (error) return callback(error);
        shell.sudo('addCollectdProfile', [ CONFIGURE_COLLECTD_CMD, 'add', app.id ], callback);
    });
}

function removeCollectdProfile(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    fs.unlink(path.join(paths.COLLECTD_APPCONFIG_DIR, app.id + '.conf'), function (error) {
        if (error && error.code !== 'ENOENT') debugApp(app, 'Error removing collectd profile', error);
        shell.sudo('removeCollectdProfile', [ CONFIGURE_COLLECTD_CMD, 'remove', app.id ], callback);
    });
}

function addLogrotateConfig(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    docker.inspect(app.containerId, function (error, result) {
        if (error) return callback(error);

        var runVolume = result.Mounts.find(function (mount) { return mount.Destination === '/run'; });
        if (!runVolume) return callback(new Error('App does not have /run mounted'));

        // logrotate configs can have arbitrary commands, so the config files must be owned by root
        var logrotateConf = ejs.render(LOGROTATE_CONFIG_EJS, { volumePath: runVolume.Source });
        var tmpFilePath = path.join(os.tmpdir(), app.id + '.logrotate');
        fs.writeFile(tmpFilePath, logrotateConf, function (error) {
            if (error) return callback(error);
            shell.sudo('addLogrotateConfig', [ CONFIGURE_LOGROTATE_CMD, 'add', app.id, tmpFilePath ], callback);
        });
    });
}

function removeLogrotateConfig(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    shell.sudo('removeLogrotateConfig', [ CONFIGURE_LOGROTATE_CMD, 'remove', app.id ], callback);
}

function verifyManifest(manifest, callback) {
    assert.strictEqual(typeof manifest, 'object');
    assert.strictEqual(typeof callback, 'function');

    var error = manifestFormat.parse(manifest);
    if (error) return callback(new Error(util.format('Manifest error: %s', error.message)));

    error = apps.checkManifestConstraints(manifest);
    if (error) return callback(error);

    return callback(null);
}

function downloadIcon(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    // nothing to download if we dont have an appStoreId
    if (!app.appStoreId) return callback(null);

    debugApp(app, 'Downloading icon of %s@%s', app.appStoreId, app.manifest.version);

    var iconUrl = config.apiServerOrigin() + '/api/v1/apps/' + app.appStoreId + '/versions/' + app.manifest.version + '/icon';

    async.retry({ times: 10, interval: 5000 }, function (retryCallback) {
        superagent
            .get(iconUrl)
            .buffer(true)
            .timeout(30 * 1000)
            .end(function (error, res) {
                if (error && !error.response) return retryCallback(new Error('Network error downloading icon:' + error.message));
                if (res.statusCode !== 200) return retryCallback(null); // ignore error. this can also happen for apps installed with cloudron-cli

                if (!safe.fs.writeFileSync(path.join(paths.APP_ICONS_DIR, app.id + '.png'), res.body)) return retryCallback(new Error('Error saving icon:' + safe.error.message));

                retryCallback(null);
            });
    }, callback);
}

function registerSubdomain(app, overwrite, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof overwrite, 'boolean');
    assert.strictEqual(typeof callback, 'function');

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(error);

        async.retry({ times: 200, interval: 5000 }, function (retryCallback) {
            debugApp(app, 'Registering subdomain location [%s] overwrite: %s', config.appFqdn(app), overwrite);

            // get the current record before updating it
            domains.getDNSRecords(config.appFqdn(app), 'A', function (error, values) {
                if (error) return retryCallback(error);

                // refuse to update any existing DNS record for custom domains that we did not create
                // note that the appstore sets up the naked domain for non-custom domains
                if (config.isCustomDomain() && values.length !== 0 && !overwrite) return retryCallback(null, new Error('DNS Record already exists'));

                domains.upsertDNSRecords(config.appFqdn(app), 'A', [ ip ], function (error, changeId) {
                    if (error && (error.reason === DomainError.STILL_BUSY || error.reason === DomainError.EXTERNAL_ERROR)) return retryCallback(error); // try again

                    retryCallback(null, error || changeId);
                });
            });
        }, function (error, result) {
            if (error || result instanceof Error) return callback(error || result);

            // dnsRecordId tracks whether we created this DNS record so that we can unregister later
            updateApp(app, { dnsRecordId: result }, callback);
        });
    });
}

function unregisterSubdomain(app, location, domain, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof location, 'string');
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof callback, 'function');

    // FIXME remove the oldConfig.domain fallback in following releases
    domain = domain || config.fqdn();

    // do not unregister bare domain because we show a error/cloudron info page there
    if (!config.isCustomDomain() && location === '') {
        debugApp(app, 'Skip unregister of empty subdomain');
        return callback(null);
    }

    if (!app.dnsRecordId) {
        debugApp(app, 'Skip unregister of record not created by cloudron');
        return callback(null);
    }

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(error);

        async.retry({ times: 30, interval: 5000 }, function (retryCallback) {
            debugApp(app, 'Unregistering subdomain: %s', config.appFqdn({ domain: domain, location: location }));

            domains.removeDNSRecords(config.appFqdn({ domain: domain, location: location }), 'A', [ ip ], function (error) {
                if (error && (error.reason === DomainError.STILL_BUSY || error.reason === DomainError.EXTERNAL_ERROR)) return retryCallback(error); // try again

                retryCallback(null, error);
            });
        }, function (error, result) {
            if (error || result instanceof Error) return callback(error || result);

            updateApp(app, { dnsRecordId: null }, callback);
        });
    });
}

function removeIcon(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    fs.unlink(path.join(paths.APP_ICONS_DIR, app.id + '.png'), function (error) {
        if (error && error.code !== 'ENOENT') debugApp(app, 'cannot remove icon : %s', error);
        callback(null);
    });
}

function waitForDnsPropagation(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!config.CLOUDRON) {
        debugApp(app, 'Skipping dns propagation check for development');
        return callback(null);
    }

    sysinfo.getPublicIp(function (error, ip) {
        if (error) return callback(error);

        domains.waitForDNSRecord(config.appFqdn(app), ip, 'A', { interval: 5000, times: 120 }, callback);
    });
}

function waitForAltDomainDnsPropagation(app, callback) {
    if (!app.altDomain) return callback(null);

    // try for 10 minutes before giving up. this allows the user to "reconfigure" the app in the case where
    // an app has an external domain and cloudron is migrated to custom domain.
    var isNakedDomain = tld.getDomain(app.altDomain) === app.altDomain;
    if (isNakedDomain) { // check naked domains with A record since CNAME records don't work there
        sysinfo.getPublicIp(function (error, ip) {
            if (error) return callback(error);

            domains.waitForDNSRecord(app.altDomain, ip, 'A', { interval: 10000, times: 60 }, callback);
        });
    } else {
        domains.waitForDNSRecord(app.altDomain, config.appFqdn(app) + '.', 'CNAME', { interval: 10000, times: 60 }, callback);
    }
}

// updates the app object and the database
function updateApp(app, values, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof values, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'updating app with values: %j', values);

    appdb.update(app.id, values, function (error) {
        if (error) return callback(error);

        for (var value in values) {
            app[value] = values[value];
        }

        return callback(null);
    });
}

// Ordering is based on the following rationale:
//   - configure nginx, icon, oauth
//   - register subdomain.
//          at this point, the user can visit the site and the above nginx config can show some install screen.
//          the icon can be displayed in this nginx page and oauth proxy means the page can be protected
//   - download image
//   - setup volumes
//   - setup addons (requires the above volume)
//   - setup the container (requires image, volumes, addons)
//   - setup collectd (requires container id)
// restore is also handled here since restore is just an install with some oldConfig to clean up
function install(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    const restoreConfig = app.restoreConfig, isRestoring = app.installationState === appdb.ISTATE_PENDING_RESTORE;

    async.series([
        // this protects against the theoretical possibility of an app being marked for install/restore from
        // a previous version of box code
        verifyManifest.bind(null, app.manifest),

        // teardown for re-installs
        updateApp.bind(null, app, { installationProgress: '10, Cleaning up old install' }),
        unconfigureNginx.bind(null, app),
        removeCollectdProfile.bind(null, app),
        removeLogrotateConfig.bind(null, app),
        stopApp.bind(null, app),
        deleteContainers.bind(null, app),
        // oldConfig can be null during upgrades
        addons.teardownAddons.bind(null, app, app.oldConfig ? app.oldConfig.manifest.addons : app.manifest.addons),
        deleteVolume.bind(null, app, { removeDirectory: false }), // do not remove any symlinked volume

        // for restore case
        function deleteImageIfChanged(done) {
            if (!app.oldConfig || (app.oldConfig.manifest.dockerImage === app.manifest.dockerImage)) return done();

            docker.deleteImage(app.oldConfig.manifest, done);
        },

        reserveHttpPort.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '20, Downloading icon' }),
        downloadIcon.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '30, Registering subdomain' }),
        registerSubdomain.bind(null, app, isRestoring /* overwrite */),

        updateApp.bind(null, app, { installationProgress: '40, Downloading image' }),
        docker.downloadImage.bind(null, app.manifest),

        updateApp.bind(null, app, { installationProgress: '50, Creating volume' }),
        createVolume.bind(null, app),

        function restoreFromBackup(next) {
            if (!restoreConfig) {
                async.series([
                    updateApp.bind(null, app, { installationProgress: '60, Setting up addons' }),
                    addons.setupAddons.bind(null, app, app.manifest.addons),
                ], next);
            } else {
                async.series([
                    updateApp.bind(null, app, { installationProgress: '60, Download backup and restoring addons' }),
                    backups.restoreApp.bind(null, app, app.manifest.addons, restoreConfig),
                ], next);
            }
        },

        updateApp.bind(null, app, { installationProgress: '70, Creating container' }),
        createContainer.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '75, Setting up logrotate config' }),
        addLogrotateConfig.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '80, Setting up collectd profile' }),
        addCollectdProfile.bind(null, app),

        runApp.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '85, Waiting for DNS propagation' }),
        exports._waitForDnsPropagation.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '90, Waiting for External Domain setup' }),
        exports._waitForAltDomainDnsPropagation.bind(null, app), // required when restoring and !restoreConfig

        updateApp.bind(null, app, { installationProgress: '95, Configure nginx' }),
        configureNginx.bind(null, app),

        // done!
        function (callback) {
            debugApp(app, 'installed');
            updateApp(app, { installationState: appdb.ISTATE_INSTALLED, installationProgress: '', health: null }, callback);
        }
    ], function seriesDone(error) {
        if (error) {
            debugApp(app, 'error installing app: %s', error);
            return updateApp(app, { installationState: appdb.ISTATE_ERROR, installationProgress: error.message }, callback.bind(null, error));
        }
        callback(null);
    });
}

function backup(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    async.series([
        updateApp.bind(null, app, { installationProgress: '10, Backing up' }),
        backups.backupApp.bind(null, app),

        // done!
        function (callback) {
            debugApp(app, 'installed');
            updateApp(app, { installationState: appdb.ISTATE_INSTALLED, installationProgress: '' }, callback);
        }
    ], function seriesDone(error) {
        if (error) {
            debugApp(app, 'error backing up app: %s', error);
            return updateApp(app, { installationState: appdb.ISTATE_INSTALLED, installationProgress: error.message }, callback.bind(null, error)); // return to installed state intentionally
        }
        callback(null);
    });
}

// note that configure is called after an infra update as well
function configure(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    // oldConfig can be null during an infra update
    var locationChanged = app.oldConfig && (config.appFqdn(app.oldConfig) !== config.appFqdn(app));

    async.series([
        updateApp.bind(null, app, { installationProgress: '10, Cleaning up old install' }),
        unconfigureNginx.bind(null, app),
        removeCollectdProfile.bind(null, app),
        removeLogrotateConfig.bind(null, app),
        stopApp.bind(null, app),
        deleteContainers.bind(null, app),
        function (next) {
            if (!locationChanged) return next();
            unregisterSubdomain(app, app.oldConfig.location, app.oldConfig.domain, next);
        },

        reserveHttpPort.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '20, Downloading icon' }),
        downloadIcon.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '35, Registering subdomain' }),
        registerSubdomain.bind(null, app, !locationChanged /* overwrite */), // if location changed, do not overwrite to detect conflicts

        updateApp.bind(null, app, { installationProgress: '40, Downloading image' }),
        docker.downloadImage.bind(null, app.manifest),

        updateApp.bind(null, app, { installationProgress: '45, Ensuring volume' }),
        createVolume.bind(null, app),

        // re-setup addons since they rely on the app's fqdn (e.g oauth)
        updateApp.bind(null, app, { installationProgress: '50, Setting up addons' }),
        addons.setupAddons.bind(null, app, app.manifest.addons),

        updateApp.bind(null, app, { installationProgress: '60, Creating container' }),
        createContainer.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '65, Setting up logrotate config' }),
        addLogrotateConfig.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '70, Add collectd profile' }),
        addCollectdProfile.bind(null, app),

        runApp.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '80, Waiting for DNS propagation' }),
        exports._waitForDnsPropagation.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '85, Waiting for External Domain setup' }),
        exports._waitForAltDomainDnsPropagation.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '90, Configuring Nginx' }),
        configureNginx.bind(null, app),

        // done!
        function (callback) {
            debugApp(app, 'configured');
            updateApp(app, { installationState: appdb.ISTATE_INSTALLED, installationProgress: '', health: null }, callback);
        }
    ], function seriesDone(error) {
        if (error) {
            debugApp(app, 'error reconfiguring : %s', error);
            return updateApp(app, { installationState: appdb.ISTATE_ERROR, installationProgress: error.message }, callback.bind(null, error));
        }
        callback(null);
    });
}

// nginx configuration is skipped because app.httpPort is expected to be available
function update(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, `Updating to ${app.updateConfig.manifest.version}`);

    // app does not want these addons anymore
    // FIXME: this does not handle option changes (like multipleDatabases)
    var unusedAddons = _.omit(app.manifest.addons, Object.keys(app.updateConfig.manifest.addons));

    async.series([
        // this protects against the theoretical possibility of an app being marked for update from
        // a previous version of box code
        updateApp.bind(null, app, { installationProgress: '0, Verify manifest' }),
        verifyManifest.bind(null, app.updateConfig.manifest),

        function (next) {
            if (app.installationState === appdb.ISTATE_PENDING_FORCE_UPDATE) return next(null);

            async.series([
                updateApp.bind(null, app, { installationProgress: '15, Backing up app' }),
                backups.backupApp.bind(null, app)
            ], next);
        },

        // download new image before app is stopped. this is so we can reduce downtime
        // and also not remove the 'common' layers when the old image is deleted
        updateApp.bind(null, app, { installationProgress: '25, Downloading image' }),
        docker.downloadImage.bind(null, app.updateConfig.manifest),

        // note: we cleanup first and then backup. this is done so that the app is not running should backup fail
        // we cannot easily 'recover' from backup failures because we have to revert manfest and portBindings
        updateApp.bind(null, app, { installationProgress: '35, Cleaning up old install' }),
        removeCollectdProfile.bind(null, app),
        removeLogrotateConfig.bind(null, app),
        stopApp.bind(null, app),
        deleteContainers.bind(null, app),
        function deleteImageIfChanged(done) {
            if (app.manifest.dockerImage === app.updateConfig.manifest.dockerImage) return done();

            docker.deleteImage(app.manifest, done);
        },

        // only delete unused addons after backup
        addons.teardownAddons.bind(null, app, unusedAddons),

        // free unused ports
        function (next) {
            // make sure we always have objects
            var currentPorts = app.portBindings || {};
            var newPorts = app.updateConfig.manifest.tcpPorts || {};

            async.each(Object.keys(currentPorts), function (portName, callback) {
                if (newPorts[portName]) return callback(); // port still in use

                appdb.delPortBinding(currentPorts[portName], function (error) {
                    if (error && error.reason === DatabaseError.NOT_FOUND) console.error('Portbinding does not exist in database.');
                    else if (error) return next(error);

                    // also delete from app object for further processing (the db is updated in the next step)
                    delete app.portBindings[portName];

                    callback();
                });
            }, next);
        },

        // switch over to the new config. manifest, memoryLimit, portBindings, appstoreId are updated here
        updateApp.bind(null, app, app.updateConfig),

        updateApp.bind(null, app, { installationProgress: '45, Downloading icon' }),
        downloadIcon.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '70, Updating addons' }),
        addons.setupAddons.bind(null, app, app.manifest.addons),

        updateApp.bind(null, app, { installationProgress: '80, Creating container' }),
        createContainer.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '85, Setting up logrotate config' }),
        addLogrotateConfig.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '90, Add collectd profile' }),
        addCollectdProfile.bind(null, app),

        runApp.bind(null, app),

        // done!
        function (callback) {
            debugApp(app, 'updated');
            updateApp(app, { installationState: appdb.ISTATE_INSTALLED, installationProgress: '', health: null, updateConfig: null, updateTime: new Date() }, callback);
        }
    ], function seriesDone(error) {
        if (error) {
            debugApp(app, 'Error updating app: %s', error);
            return updateApp(app, { installationState: appdb.ISTATE_ERROR, installationProgress: error.message, updateTime: new Date() }, callback.bind(null, error));
        }
        callback(null);
    });
}

function uninstall(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    debugApp(app, 'uninstalling');

    async.series([
        updateApp.bind(null, app, { installationProgress: '0, Remove collectd profile' }),
        removeCollectdProfile.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '5, Remove logrotate config' }),
        removeLogrotateConfig.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '10, Stopping app' }),
        stopApp.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '20, Deleting container' }),
        deleteContainers.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '30, Teardown addons' }),
        addons.teardownAddons.bind(null, app, app.manifest.addons),

        updateApp.bind(null, app, { installationProgress: '40, Deleting volume' }),
        deleteVolume.bind(null, app, { removeDirectory: true }),

        updateApp.bind(null, app, { installationProgress: '50, Deleting image' }),
        docker.deleteImage.bind(null, app.manifest),

        updateApp.bind(null, app, { installationProgress: '60, Unregistering subdomain' }),
        unregisterSubdomain.bind(null, app, app.location, app.domain),

        updateApp.bind(null, app, { installationProgress: '80, Cleanup icon' }),
        removeIcon.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '90, Unconfiguring Nginx' }),
        unconfigureNginx.bind(null, app),

        updateApp.bind(null, app, { installationProgress: '95, Remove app from database' }),
        appdb.del.bind(null, app.id)
    ], function seriesDone(error) {
        if (error) {
            debugApp(app, 'error uninstalling app: %s', error);
            return updateApp(app, { installationState: appdb.ISTATE_ERROR, installationProgress: error.message }, callback.bind(null, error));
        }
        callback(null);
    });
}

function runApp(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    docker.startContainer(app.containerId, function (error) {
        if (error) return callback(error);

        updateApp(app, { runState: appdb.RSTATE_RUNNING }, callback);
    });
}

function stopApp(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    docker.stopContainers(app.id, function (error) {
        if (error) return callback(error);

        updateApp(app, { runState: appdb.RSTATE_STOPPED, health: null }, callback);
    });
}

function handleRunCommand(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (app.runState === appdb.RSTATE_PENDING_STOP) {
        return stopApp(app, callback);
    }

    if (app.runState === appdb.RSTATE_PENDING_START || app.runState === appdb.RSTATE_RUNNING) {
        debugApp(app, 'Resuming app with state : %s', app.runState);
        return runApp(app, callback);
    }

    debugApp(app, 'handleRunCommand - doing nothing: %s', app.runState);

    return callback(null);
}

function startTask(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    // determine what to do
    appdb.get(appId, function (error, app) {
        if (error) return callback(error);

        debugApp(app, 'startTask installationState: %s runState: %s', app.installationState, app.runState);

        switch (app.installationState) {
        case appdb.ISTATE_PENDING_UNINSTALL: return uninstall(app, callback);
        case appdb.ISTATE_PENDING_CONFIGURE: return configure(app, callback);

        case appdb.ISTATE_PENDING_UPDATE: return update(app, callback);
        case appdb.ISTATE_PENDING_FORCE_UPDATE: return update(app, callback);

        case appdb.ISTATE_PENDING_INSTALL: return install(app, callback);
        case appdb.ISTATE_PENDING_CLONE: return install(app, callback);
        case appdb.ISTATE_PENDING_RESTORE: return install(app, callback);

        case appdb.ISTATE_PENDING_BACKUP: return backup(app, callback);
        case appdb.ISTATE_INSTALLED: return handleRunCommand(app, callback);

        case appdb.ISTATE_ERROR:
            debugApp(app, 'Internal error. apptask launched with error status.');
            return callback(null);
        default:
            debugApp(app, 'apptask launched with invalid command');
            return callback(new Error('Unknown command in apptask:' + app.installationState));
        }
    });
}

if (require.main === module) {
    assert.strictEqual(process.argv.length, 3, 'Pass the appid as argument');

    debug('Apptask for %s', process.argv[2]);

    process.on('SIGTERM', function () {
        debug('taskmanager sent SIGTERM since it got a new task for this app');
        process.exit(0);
    });

    initialize(function (error) {
        if (error) throw error;

        startTask(process.argv[2], function (error) {
            if (error) debug('Apptask completed with error', error);

            debug('Apptask completed for %s', process.argv[2]);
            // https://nodejs.org/api/process.html are exit codes used by node. apps.js uses the value below
            // to check apptask crashes
            process.exit(error ? 50 : 0);
        });
    });
}
