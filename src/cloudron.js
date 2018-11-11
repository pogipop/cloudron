'use strict';

exports = module.exports = {
    CloudronError: CloudronError,

    initialize: initialize,
    uninitialize: uninitialize,
    getConfig: getConfig,
    getDisks: getDisks,
    getLogs: getLogs,

    reboot: reboot,

    onActivated: onActivated,

    checkDiskSpace: checkDiskSpace
};

var assert = require('assert'),
    async = require('async'),
    config = require('./config.js'),
    cron = require('./cron.js'),
    debug = require('debug')('box:cloudron'),
    df = require('@sindresorhus/df'),
    mailer = require('./mailer.js'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    platform = require('./platform.js'),
    progress = require('./progress.js'),
    reverseProxy = require('./reverseproxy.js'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    shell = require('./shell.js'),
    spawn = require('child_process').spawn,
    split = require('split'),
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
CloudronError.NOT_FOUND = 'Not found';
CloudronError.SELF_UPGRADE_NOT_SUPPORTED = 'Self upgrade not supported';

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    cron.startPreActivationJobs(callback);

    runStartupTasks();
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
        cron.startPostActivationJobs
    ], callback);
}

// each of these tasks can fail. we will add some routes to fix/re-run them
function runStartupTasks() {
    // configure nginx to be reachable by IP
    reverseProxy.configureDefaultServer(NOOP_CALLBACK);

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
            apiServerOrigin: config.apiServerOrigin(),
            webServerOrigin: config.webServerOrigin(),
            adminDomain: config.adminDomain(),
            adminFqdn: config.adminFqdn(),
            mailFqdn: config.mailFqdn(),
            version: config.version(),
            progress: progress.getAll(),
            isDemo: config.isDemo(),
            edition: config.edition(),
            memory: os.totalmem(),
            provider: config.provider(),
            cloudronName: allSettings[settings.CLOUDRON_NAME_KEY]
        });
    });
}

function reboot(callback) {
    shell.sudo('reboot', [ REBOOT_CMD ], callback);
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

function getLogs(unit, options, callback) {
    assert.strictEqual(typeof unit, 'string');
    assert(options && typeof options === 'object');
    assert.strictEqual(typeof callback, 'function');

    var lines = options.lines || 100,
        format = options.format || 'json',
        follow = !!options.follow;

    assert.strictEqual(typeof lines, 'number');
    assert.strictEqual(typeof format, 'string');

    assert.strictEqual(typeof lines, 'number');
    assert.strictEqual(typeof format, 'string');

    debug('Getting logs for %s as %s', unit, format);

    var cp, transformStream;
    if (unit === 'box') {
        let args = [ '--no-pager', `--lines=${lines}` ];
        if (format === 'short') args.push('--output=short', '-a'); else args.push('--output=json');
        if (follow) args.push('--follow');
        args.push('--unit=box');
        args.push('--unit=cloudron-updater');
        cp = spawn('/bin/journalctl', args);

        transformStream = split(function mapper(line) {
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
    } else { // mail, mongodb, mysql, postgresql, backup
        let args = [ '--lines=' + lines ];
        if (follow) args.push('--follow');
        args.push(path.join(paths.LOG_DIR, unit, 'app.log'));

        cp = spawn('/usr/bin/tail', args);

        transformStream = split(function mapper(line) {
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
    }

    transformStream.close = cp.kill.bind(cp, 'SIGKILL'); // closing stream kills the child process

    cp.stdout.pipe(transformStream);

    return callback(null, transformStream);
}
