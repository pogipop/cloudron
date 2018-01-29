'use strict';

exports = module.exports = {
    CloudronError: CloudronError,

    initialize: initialize,
    uninitialize: uninitialize,
    getConfig: getConfig,
    getDisks: getDisks,
    getLogs: getLogs,

    updateToLatest: updateToLatest,
    reboot: reboot,

    onActivated: onActivated,

    checkDiskSpace: checkDiskSpace
};

var assert = require('assert'),
    async = require('async'),
    backups = require('./backups.js'),
    caas = require('./caas.js'),
    config = require('./config.js'),
    cron = require('./cron.js'),
    debug = require('debug')('box:cloudron'),
    df = require('@sindresorhus/df'),
    eventlog = require('./eventlog.js'),
    fs = require('fs'),
    locker = require('./locker.js'),
    mailer = require('./mailer.js'),
    nginx = require('./nginx.js'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    platform = require('./platform.js'),
    progress = require('./progress.js'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    shell = require('./shell.js'),
    spawn = require('child_process').spawn,
    split = require('split'),
    updateChecker = require('./updatechecker.js'),
    user = require('./user.js'),
    util = require('util'),
    _ = require('underscore');

var REBOOT_CMD = path.join(__dirname, 'scripts/reboot.sh'),
    UPDATE_CMD = path.join(__dirname, 'scripts/update.sh');

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
CloudronError.NOT_FOUND = 'Not found';
CloudronError.SELF_UPGRADE_NOT_SUPPORTED = 'Self upgrade not supported';

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    async.series([
        settings.initialize,
        configureDefaultServer,
        cron.initialize, // required for caas heartbeat before activation
        onActivated
    ], callback);
}

function uninitialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    async.series([
        cron.uninitialize,
        platform.stop,
        settings.uninitialize
    ], callback);
}

function onActivated(callback) {
    callback = callback || NOOP_CALLBACK;

    // Starting the platform after a user is available means:
    // 1. mail bounces can now be sent to the cloudron owner
    // 2. the restore code path can run without sudo (since mail/ is non-root)
    user.count(function (error, count) {
        if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));
        if (!count) return callback(); // not activated

        platform.start(callback);
    });
}

function configureDefaultServer(callback) {
    callback = callback || NOOP_CALLBACK;

    if (process.env.BOX_ENV === 'test') return callback();

    var certFilePath = path.join(paths.NGINX_CERT_DIR,  'default.cert');
    var keyFilePath = path.join(paths.NGINX_CERT_DIR, 'default.key');

    if (!fs.existsSync(certFilePath) || !fs.existsSync(keyFilePath)) {
        debug('configureDefaultServer: create new cert');

        var cn = 'cloudron-' + (new Date()).toISOString(); // randomize date a bit to keep firefox happy
        var certCommand = util.format('openssl req -x509 -newkey rsa:2048 -keyout %s -out %s -days 3650 -subj /CN=%s -nodes', keyFilePath, certFilePath, cn);
        safe.child_process.execSync(certCommand);
    }

    nginx.configureAdmin(certFilePath, keyFilePath, 'default.conf', '', function (error) {
        if (error) return callback(error);

        debug('configureDefaultServer: done');

        callback(null);
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

    // result to not depend on the appstore
    const BOX_AND_USER_TEMPLATE = {
        box: {
            region: null,
            size: null,
            plan: 'Custom Plan'
        },
        user: {
            billing: false,
            currency: ''
        }
    };

    caas.getBoxAndUserDetails(function (error, result) {
        if (error) debug('Failed to fetch cloudron details.', error.reason, error.message);

        result = _.extend(BOX_AND_USER_TEMPLATE, result || {});

        settings.getCloudronName(function (error, cloudronName) {
            if (error) return callback(new CloudronError(CloudronError.INTERNAL_ERROR, error));

            callback(null, {
                apiServerOrigin: config.apiServerOrigin(),
                webServerOrigin: config.webServerOrigin(),
                adminDomain: config.adminDomain(),
                adminLocation: config.adminLocation(),
                adminFqdn: config.adminFqdn(),
                mailFqdn: config.mailFqdn(),
                version: config.version(),
                update: updateChecker.getUpdateInfo(),
                progress: progress.getAll(),
                isDemo: config.isDemo(),
                region: result.box.region,
                size: result.box.size,
                billing: !!result.user.billing,
                plan: result.box.plan,
                currency: result.user.currency,
                memory: os.totalmem(),
                provider: config.provider(),
                cloudronName: cloudronName
            });
        });
    });
}

function reboot(callback) {
    shell.sudo('reboot', [ REBOOT_CMD ], callback);
}

function update(boxUpdateInfo, auditSource, callback) {
    assert.strictEqual(typeof boxUpdateInfo, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!boxUpdateInfo) return callback(null);

    var error = locker.lock(locker.OP_BOX_UPDATE);
    if (error) return callback(new CloudronError(CloudronError.BAD_STATE, error.message));

    eventlog.add(eventlog.ACTION_UPDATE, auditSource, { boxUpdateInfo: boxUpdateInfo });

    // ensure tools can 'wait' on progress
    progress.set(progress.UPDATE, 0, 'Starting');

    // initiate the update/upgrade but do not wait for it
    if (boxUpdateInfo.upgrade) {
        debug('Starting upgrade');
        caas.upgrade(boxUpdateInfo, function (error) {
            if (error) {
                debug('Upgrade failed with error:', error);
                locker.unlock(locker.OP_BOX_UPDATE);
            }
        });
    } else {
        debug('Starting update');
        doUpdate(boxUpdateInfo, function (error) {
            if (error) {
                debug('Update failed with error:', error);
                locker.unlock(locker.OP_BOX_UPDATE);
            }
        });
    }

    callback(null);
}

function updateToLatest(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    var boxUpdateInfo = updateChecker.getUpdateInfo().box;
    if (!boxUpdateInfo) return callback(new CloudronError(CloudronError.ALREADY_UPTODATE, 'No update available'));
    if (!boxUpdateInfo.sourceTarballUrl) return callback(new CloudronError(CloudronError.BAD_STATE, 'No automatic update available'));

    // check if this is just a version number change
    if (config.version().match(/[-+]/) !== null && config.version().replace(/[-+].*/, '') === boxUpdateInfo.version) {
        doShortCircuitUpdate(boxUpdateInfo, function (error) {
            if (error) debug('Short-circuit update failed', error);
        });

        return callback(null);
    }

    if (boxUpdateInfo.upgrade && config.provider() !== 'caas') return callback(new CloudronError(CloudronError.SELF_UPGRADE_NOT_SUPPORTED));

    update(boxUpdateInfo, auditSource, callback);
}

function doShortCircuitUpdate(boxUpdateInfo, callback) {
    assert(boxUpdateInfo !== null && typeof boxUpdateInfo === 'object');

    debug('Starting short-circuit from prerelease version %s to release version %s', config.version(), boxUpdateInfo.version);
    config.setVersion(boxUpdateInfo.version);
    progress.clear(progress.UPDATE);
    updateChecker.resetUpdateInfo();
    callback();
}

function doUpdate(boxUpdateInfo, callback) {
    assert(boxUpdateInfo && typeof boxUpdateInfo === 'object');

    function updateError(e) {
        progress.set(progress.UPDATE, -1, e.message);
        callback(e);
    }

    progress.set(progress.UPDATE, 5, 'Backing up for update');

    backups.backupBoxAndApps({ userId: null, username: 'updater' }, function (error) {
        if (error) return updateError(error);

        // NOTE: this data is opaque and will be passed through the installer.sh
        var data= {
            provider: config.provider(),
            apiServerOrigin: config.apiServerOrigin(),
            webServerOrigin: config.webServerOrigin(),
            adminDomain: config.adminDomain(),
            adminFqdn: config.adminFqdn(),
            adminLocation: config.adminLocation(),
            isDemo: config.isDemo(),

            appstore: {
                apiServerOrigin: config.apiServerOrigin()
            },
            caas: {
                apiServerOrigin: config.apiServerOrigin(),
                webServerOrigin: config.webServerOrigin()
            },

            version: boxUpdateInfo.version
        };

        debug('updating box %s %j', boxUpdateInfo.sourceTarballUrl, _.omit(data, 'tlsCert', 'tlsKey', 'token', 'appstore', 'caas'));

        progress.set(progress.UPDATE, 5, 'Downloading and extracting new version');

        shell.sudo('update', [ UPDATE_CMD, boxUpdateInfo.sourceTarballUrl, JSON.stringify(data) ], function (error) {
            if (error) return updateError(error);

            // Do not add any code here. The installer script will stop the box code any instant
        });
    });
}

function checkDiskSpace(callback) {
    callback = callback || NOOP_CALLBACK;

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

            if (oos) mailer.outOfDiskSpace(JSON.stringify(entries, null, 4));

            callback();
        }).catch(function (error) {
            debug('df error %s', error.message);
            mailer.outOfDiskSpace(error.message);
            return callback();
        });
    });
}

function getLogs(options, callback) {
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    var units = options.units || [],
        lines = options.lines || 100,
        format = options.format || 'json',
        follow = !!options.follow;

    assert(Array.isArray(units));
    assert.strictEqual(typeof lines, 'number');
    assert.strictEqual(typeof format, 'string');

    debug('Getting logs for %j', units);

    var args = [ '--no-pager', '--lines=' + lines ];
    units.forEach(function (u) {
        if (u === 'box') args.push('--unit=box');
        else if (u === 'mail') args.push('CONTAINER_NAME=mail');
    });
    if (format === 'short') args.push('--output=short', '-a'); else args.push('--output=json');
    if (follow) args.push('--follow');

    var cp = spawn('/bin/journalctl', args);

    var transformStream = split(function mapper(line) {
        if (format !== 'json') return line + '\n';

        var obj = safe.JSON.parse(line);
        if (!obj) return undefined;

        return JSON.stringify({
            realtimeTimestamp: obj.__REALTIME_TIMESTAMP,
            monotonicTimestamp: obj.__MONOTONIC_TIMESTAMP,
            message: obj.MESSAGE,
            source: obj.SYSLOG_IDENTIFIER || ''
        }) + '\n';
    });

    transformStream.close = cp.kill.bind(cp, 'SIGKILL'); // closing stream kills the child process

    cp.stdout.pipe(transformStream);

    return callback(null, transformStream);
}
