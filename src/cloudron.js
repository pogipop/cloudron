'use strict';

exports = module.exports = {
    CloudronError: CloudronError,

    initialize: initialize,
    uninitialize: uninitialize,
    getConfig: getConfig,
    getDisks: getDisks,
    getLogs: getLogs,

    reboot: reboot,
    isRebootRequired: isRebootRequired,

    onActivated: onActivated,

    prepareDashboardDomain: prepareDashboardDomain,
    setDashboardDomain: setDashboardDomain,
    setDashboardAndMailDomain: setDashboardAndMailDomain,
    renewCerts: renewCerts,

    setupDashboard: setupDashboard,

    runSystemChecks: runSystemChecks,

    // exposed for testing
    _checkDiskSpace: checkDiskSpace
};

var apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    auditSource = require('./auditsource.js'),
    backups = require('./backups.js'),
    clients = require('./clients.js'),
    constants = require('./constants.js'),
    cron = require('./cron.js'),
    debug = require('debug')('box:cloudron'),
    domains = require('./domains.js'),
    DomainsError = require('./domains.js').DomainsError,
    df = require('@sindresorhus/df'),
    eventlog = require('./eventlog.js'),
    custom = require('./custom.js'),
    fs = require('fs'),
    mail = require('./mail.js'),
    notifications = require('./notifications.js'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    platform = require('./platform.js'),
    reverseProxy = require('./reverseproxy.js'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    shell = require('./shell.js'),
    spawn = require('child_process').spawn,
    split = require('split'),
    sysinfo = require('./sysinfo.js'),
    tasks = require('./tasks.js'),
    users = require('./users.js'),
    util = require('util');

var REBOOT_CMD = path.join(__dirname, 'scripts/reboot.sh');

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

function CloudronError(reason, errorOrMessage) {
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
util.inherits(CloudronError, Error);
CloudronError.BAD_FIELD = 'Field error';
CloudronError.INTERNAL_ERROR = 'Internal Error';
CloudronError.EXTERNAL_ERROR = 'External Error';
CloudronError.BAD_STATE = 'Bad state';
CloudronError.ALREADY_UPTODATE = 'No Update Available';

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    runStartupTasks();

    notifyUpdate(callback);
}

function uninitialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    async.series([
        cron.stopJobs,
        platform.stop
    ], callback);
}

function onActivated(callback) {
    assert.strictEqual(typeof callback, 'function');

    // Starting the platform after a user is available means:
    // 1. mail bounces can now be sent to the cloudron owner
    // 2. the restore code path can run without sudo (since mail/ is non-root)
    async.series([
        platform.start,
        cron.startJobs
    ], callback);
}

function setUpdateSuccess(callback) {
    tasks.listByTypePaged(tasks.TASK_UPDATE, 1, 1, function (error, results) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));
        if (results.length !== 1) return callback(); // when hotfixing

        tasks.update(results[0].id, { percent: 100, errorMessage: null }, function (error) {
            if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

            callback();
        });
    });
}

function notifyUpdate(callback) {
    assert.strictEqual(typeof callback, 'function');

    const version = safe.fs.readFileSync(paths.VERSION_FILE, 'utf8');
    if (version === constants.VERSION) return callback();

    eventlog.add(eventlog.ACTION_UPDATE_FINISH, auditSource.CRON, { oldVersion: version || 'dev', newVersion: constants.VERSION }, function (error) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        setUpdateSuccess(function (error) {
            if (error) return callback(error);

            safe.fs.writeFileSync(paths.VERSION_FILE, constants.VERSION, 'utf8');

            callback();
        });
    });
}

// each of these tasks can fail. we will add some routes to fix/re-run them
function runStartupTasks() {
    // configure nginx to be reachable by IP
    reverseProxy.configureDefaultServer(NOOP_CALLBACK);

    // always generate webadmin config since we have no versioning mechanism for the ejs
    if (settings.adminDomain()) reverseProxy.writeAdminConfig(settings.adminDomain(), NOOP_CALLBACK);

    // check activation state and start the platform
    users.isActivated(function (error, activated) {
        if (error) return debug(error);
        if (!activated) return debug('initialize: not activated yet'); // not activated

        onActivated(NOOP_CALLBACK);
    });
}

function getDisks(callback) {
    assert.strictEqual(typeof callback, 'function');

    var disks = {
        boxDataDisk: null,
        platformDataDisk: null,
        appsDataDisk: null
    };

    df.file(paths.BOX_DATA_DIR).then(function (result) {
        disks.boxDataDisk = result.filesystem;

        return df.file(paths.PLATFORM_DATA_DIR);
    }).then(function (result) {
        disks.platformDataDisk = result.filesystem;

        return df.file(paths.APPS_DATA_DIR);
    }).then(function (result) {
        disks.appsDataDisk = result.filesystem;

        callback(null, disks);
    }).catch(function (error) {
        callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));
    });
}

function getConfig(callback) {
    assert.strictEqual(typeof callback, 'function');

    settings.getAll(function (error, allSettings) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        // be picky about what we send out here since this is sent for 'normal' users as well
        callback(null, {
            apiServerOrigin: settings.apiServerOrigin(),
            webServerOrigin: settings.webServerOrigin(),
            adminDomain: settings.adminDomain(),
            adminFqdn: settings.adminFqdn(),
            mailFqdn: settings.mailFqdn(),
            version: constants.VERSION,
            isDemo: settings.isDemo(),
            memory: os.totalmem(),
            provider: sysinfo.provider(),
            cloudronName: allSettings[settings.CLOUDRON_NAME_KEY],
            uiSpec: custom.uiSpec()
        });
    });
}

function reboot(callback) {
    shell.sudo('reboot', [ REBOOT_CMD ], {}, callback);
}

function isRebootRequired(callback) {
    assert.strictEqual(typeof callback, 'function');

    // https://serverfault.com/questions/92932/how-does-ubuntu-keep-track-of-the-system-restart-required-flag-in-motd
    callback(null, fs.existsSync('/var/run/reboot-required'));
}

// called from cron.js
function runSystemChecks() {
    async.parallel([
        checkBackupConfiguration,
        checkDiskSpace,
        checkMailStatus,
        checkRebootRequired
    ], function (error) {
        debug('runSystemChecks: done', error);
    });
}

function checkBackupConfiguration(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Checking backup configuration');

    backups.checkConfiguration(function (error, message) {
        if (error) return callback(error);

        notifications.alert(notifications.ALERT_BACKUP_CONFIG, 'Backup configuration is unsafe', message, callback);
    });
}

function checkDiskSpace(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Checking disk space');

    getDisks(function (error, disks) {
        if (error) {
            debug('df error %s', error.message);
            return callback();
        }

        df().then(function (entries) {
            /*
                [{
                filesystem: '/dev/disk1',
                size: 499046809600,
                used: 443222245376,
                available: 55562420224,
                capacity: 0.89,
                mountpoint: '/'
            }, ...]
            */
            var oos = entries.some(function (entry) {
                // ignore other filesystems but where box, app and platform data is
                if (entry.filesystem !== disks.boxDataDisk && entry.filesystem !== disks.platformDataDisk && entry.filesystem !== disks.appsDataDisk) return false;

                return (entry.available <= (1.25 * 1024 * 1024 * 1024)); // 1.5G
            });

            debug('Disk space checked. ok: %s', !oos);

            notifications.alert(notifications.ALERT_DISK_SPACE, 'Server is running out of disk space', oos ? JSON.stringify(entries, null, 4) : '', callback);
        }).catch(function (error) {
            if (error) console.error(error);
            callback();
        });
    });
}

function checkMailStatus(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('checking mail status');

    mail.checkConfiguration(function (error, message) {
        if (error) return callback(error);

        notifications.alert(notifications.ALERT_MAIL_STATUS, 'Email is not configured properly', message, callback);
    });
}

function checkRebootRequired(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('checking if reboot required');

    isRebootRequired(function (error, rebootRequired) {
        if (error) return callback(error);

        notifications.alert(notifications.ALERT_REBOOT, 'Reboot Required', rebootRequired ? 'To finish security updates, a [reboot](/#/system) is necessary.' : '', callback);
    });
}

function getLogs(unit, options, callback) {
    assert.strictEqual(typeof unit, 'string');
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    assert.strictEqual(typeof options.lines, 'number');
    assert.strictEqual(typeof options.format, 'string');
    assert.strictEqual(typeof options.follow, 'boolean');

    var lines = options.lines === -1 ? '+1' : options.lines,
        format = options.format || 'json',
        follow = options.follow;

    debug('Getting logs for %s as %s', unit, format);

    let args = [ '--lines=' + lines ];
    if (follow) args.push('--follow');

    // need to handle box.log without subdir
    if (unit === 'box') args.push(path.join(paths.LOG_DIR, 'box.log'));
    else if (unit.startsWith('crash-')) args.push(path.join(paths.CRASH_LOG_DIR, unit.slice(6) + '.log'));
    else return callback(new CloudronError(CloudronError.BAD_FIELD, 'No such unit'));

    var cp = spawn('/usr/bin/tail', args);

    var transformStream = split(function mapper(line) {
        if (format !== 'json') return line + '\n';

        var data = line.split(' '); // logs are <ISOtimestamp> <msg>
        var timestamp = (new Date(data[0])).getTime();
        if (isNaN(timestamp)) timestamp = 0;

        return JSON.stringify({
            realtimeTimestamp: timestamp * 1000,
            message: line.slice(data[0].length+1),
            source: unit
        }) + '\n';
    });

    transformStream.close = cp.kill.bind(cp, 'SIGKILL'); // closing stream kills the child process

    cp.stdout.pipe(transformStream);

    return callback(null, transformStream);
}

function prepareDashboardDomain(domain, auditSource, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug(`prepareDashboardDomain: ${domain}`);

    domains.get(domain, function (error, domainObject) {
        if (error && error.reason === DomainsError.NOT_FOUND) return callback(new CloudronError(CloudronError.BAD_FIELD, 'No such domain'));
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        const fqdn = domains.fqdn(constants.ADMIN_LOCATION, domainObject);

        apps.getAll(function (error, result) {
            if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

            const conflict = result.filter(app => app.fqdn === fqdn);
            if (conflict.length) return callback(new CloudronError(CloudronError.BAD_STATE, 'Dashboard location conflicts with an existing app'));

            let task = tasks.startTask(tasks.TASK_PREPARE_DASHBOARD_DOMAIN, [ domain, auditSource ]);
            task.on('error', (error) => callback(new CloudronError(CloudronError.INTERNAL_ERROR, error)));
            task.on('start', (taskId) => callback(null, taskId));
        });
    });
}

// call this only pre activation since it won't start mail server
function setDashboardDomain(domain, auditSource, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug(`setDashboardDomain: ${domain}`);

    domains.get(domain, function (error, domainObject) {
        if (error && error.reason === DomainsError.NOT_FOUND) return callback(new CloudronError(CloudronError.BAD_FIELD, 'No such domain'));
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

        reverseProxy.writeAdminConfig(domain, function (error) {
            if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

            const fqdn = domains.fqdn(constants.ADMIN_LOCATION, domainObject);

            async.series([
                settings.setAdmin.bind(null, domain, fqdn),
                clients.addDefaultClients.bind(null, settings.adminOrigin()),
            ], function (error) {
                if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

                eventlog.add(eventlog.ACTION_DASHBOARD_DOMAIN_UPDATE, auditSource, { domain: domain, fqdn: fqdn });

                callback(null);
            });
        });
    });
}

// call this only post activation because it will restart mail server
function setDashboardAndMailDomain(domain, auditSource, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug(`setDashboardAndMailDomain: ${domain}`);

    setDashboardDomain(domain, auditSource, function (error) {
        if (error) return callback(error);

        mail.onMailFqdnChanged(NOOP_CALLBACK); // this will update dns and re-configure mail server

        callback(null);
    });
}

function setupDashboard(auditSource, progressCallback, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof progressCallback, 'function');
    assert.strictEqual(typeof callback, 'function');

    async.series([
        domains.prepareDashboardDomain.bind(null, settings.adminDomain(), auditSource, progressCallback),
        setDashboardDomain.bind(null, settings.adminDomain(), auditSource)
    ], callback);
}

function renewCerts(options, auditSource, callback) {
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    let task = tasks.startTask(tasks.TASK_RENEW_CERTS, [ options, auditSource ]);
    task.on('error', (error) => callback(new CloudronError(CloudronError.INTERNAL_ERROR, error)));
    task.on('start', (taskId) => callback(null, taskId));
}
