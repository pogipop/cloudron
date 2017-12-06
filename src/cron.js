'use strict';

exports = module.exports = {
    initialize: initialize,
    uninitialize: uninitialize
};

var apps = require('./apps.js'),
    appstore = require('./appstore.js'),
    assert = require('assert'),
    backups = require('./backups.js'),
    certificates = require('./certificates.js'),
    cloudron = require('./cloudron.js'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    CronJob = require('cron').CronJob,
    debug = require('debug')('box:cron'),
    digest = require('./digest.js'),
    eventlog = require('./eventlog.js'),
    janitor = require('./janitor.js'),
    scheduler = require('./scheduler.js'),
    settings = require('./settings.js'),
    semver = require('semver'),
    updateChecker = require('./updatechecker.js');

var gJobs = {
    alive: null, // send periodic stats
    autoUpdater: null,
    appUpdateChecker: null,
    backup: null,
    boxUpdateChecker: null,
    caasHeartbeat: null,
    checkDiskSpace: null,
    certificateRenew: null,
    cleanupBackups: null,
    cleanupEventlog: null,
    cleanupTokens: null,
    digestEmail: null,
    dockerVolumeCleaner: null,
    dynamicDNS: null,
    schedulerSync: null
};

var NOOP_CALLBACK = function (error) { if (error) console.error(error); };
var AUDIT_SOURCE = { userId: null, username: 'cron' };

// cron format
// Seconds: 0-59
// Minutes: 0-59
// Hours: 0-23
// Day of Month: 1-31
// Months: 0-11
// Day of Week: 0-6

function initialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (config.provider() === 'caas') {
        // hack: send the first heartbeat only after we are running for 60 seconds
        // required as we end up sending a heartbeat and then cloudron-setup reboots the server
        var seconds = (new Date()).getSeconds() - 1;
        if (seconds === -1) seconds = 59;

        gJobs.caasHeartbeat = new CronJob({
            cronTime: `${seconds} */1 * * * *`, // every minute
            onTick: cloudron.sendCaasHeartbeat,
            start: true
        });
    }

    var randomHourMinute = Math.floor(60*Math.random());
    gJobs.alive = new CronJob({
        cronTime: '00 ' + randomHourMinute + ' * * * *', // every hour on a random minute
        onTick: appstore.sendAliveStatus,
        start: true
    });

    settings.events.on(settings.TIME_ZONE_KEY, recreateJobs);
    settings.events.on(settings.AUTOUPDATE_PATTERN_KEY, autoupdatePatternChanged);
    settings.events.on(settings.DYNAMIC_DNS_KEY, dynamicDNSChanged);

    settings.getAll(function (error, allSettings) {
        if (error) return callback(error);

        recreateJobs(allSettings[settings.TIME_ZONE_KEY]);
        autoupdatePatternChanged(allSettings[settings.AUTOUPDATE_PATTERN_KEY]);
        dynamicDNSChanged(allSettings[settings.DYNAMIC_DNS_KEY]);

        callback();
    });
}

function recreateJobs(tz) {
    assert.strictEqual(typeof tz, 'string');

    debug('Creating jobs with timezone %s', tz);

    if (gJobs.backup) gJobs.backup.stop();
    gJobs.backup = new CronJob({
        cronTime: '00 00 */6 * * *', // every 6 hours. backups.ensureBackup() will only trigger a backup once per day
        onTick: backups.ensureBackup.bind(null, AUDIT_SOURCE, NOOP_CALLBACK),
        start: true,
        timeZone: tz
    });

    if (gJobs.checkDiskSpace) gJobs.checkDiskSpace.stop();
    gJobs.checkDiskSpace = new CronJob({
        cronTime: '00 30 */4 * * *', // every 4 hours
        onTick: cloudron.checkDiskSpace,
        start: true,
        timeZone: tz
    });

    // randomized pattern per cloudron every hour
    var randomMinute = Math.floor(60*Math.random());

    if (gJobs.boxUpdateCheckerJob) gJobs.boxUpdateCheckerJob.stop();
    gJobs.boxUpdateCheckerJob = new CronJob({
        cronTime: '00 ' + randomMinute + ' * * * *', // once an hour
        onTick: updateChecker.checkBoxUpdates,
        start: true,
        timeZone: tz
    });

    if (gJobs.appUpdateChecker) gJobs.appUpdateChecker.stop();
    gJobs.appUpdateChecker = new CronJob({
        cronTime: '00 ' + randomMinute + ' * * * *', // once an hour
        onTick: updateChecker.checkAppUpdates,
        start: true,
        timeZone: tz
    });

    if (gJobs.cleanupTokens) gJobs.cleanupTokens.stop();
    gJobs.cleanupTokens = new CronJob({
        cronTime: '00 */30 * * * *', // every 30 minutes
        onTick: janitor.cleanupTokens,
        start: true,
        timeZone: tz
    });

    if (gJobs.cleanupBackups) gJobs.cleanupBackups.stop();
    gJobs.cleanupBackups = new CronJob({
        cronTime: '00 45 */6 * * *', // every 6 hours. try not to overlap with ensureBackup job
        onTick: backups.cleanup.bind(null, AUDIT_SOURCE, NOOP_CALLBACK),
        start: true,
        timeZone: tz
    });

    if (gJobs.cleanupEventlog) gJobs.cleanupEventlog.stop();
    gJobs.cleanupEventlog = new CronJob({
        cronTime: '00 */30 * * * *', // every 30 minutes
        onTick: eventlog.cleanup,
        start: true,
        timeZone: tz
    });

    if (gJobs.dockerVolumeCleaner) gJobs.dockerVolumeCleaner.stop();
    gJobs.dockerVolumeCleaner = new CronJob({
        cronTime: '00 00 */12 * * *', // every 12 hours
        onTick: janitor.cleanupDockerVolumes,
        start: true,
        timeZone: tz
    });

    if (gJobs.schedulerSync) gJobs.schedulerSync.stop();
    gJobs.schedulerSync = new CronJob({
        cronTime: config.TEST ? '*/10 * * * * *' : '00 */1 * * * *', // every minute
        onTick: scheduler.sync,
        start: true,
        timeZone: tz
    });

    if (gJobs.certificateRenew) gJobs.certificateRenew.stop();
    gJobs.certificateRenew = new CronJob({
        cronTime: '00 00 */12 * * *', // every 12 hours
        onTick: certificates.renewAll.bind(null, AUDIT_SOURCE, NOOP_CALLBACK),
        start: true,
        timeZone: tz
    });

    if (gJobs.digestEmail) gJobs.digestEmail.stop();
    gJobs.digestEmail = new CronJob({
        cronTime: '00 00 00 * * 3', // every wednesday
        onTick: digest.maybeSend,
        start: true,
        timeZone: tz
    });
}

function autoupdatePatternChanged(pattern) {
    assert.strictEqual(typeof pattern, 'string');
    assert(gJobs.boxUpdateCheckerJob);

    debug('Auto update pattern changed to %s', pattern);

    if (gJobs.autoUpdater) gJobs.autoUpdater.stop();

    if (pattern === constants.AUTOUPDATE_PATTERN_NEVER) return;

    gJobs.autoUpdater = new CronJob({
        cronTime: pattern,
        onTick: function() {
            var updateInfo = updateChecker.getUpdateInfo();
            if (updateInfo.box) {
                if (semver.major(updateInfo.box.version) === semver.major(config.version())) {
                    debug('Starting autoupdate to %j', updateInfo.box);
                    cloudron.updateToLatest(AUDIT_SOURCE, NOOP_CALLBACK);
                } else {
                    debug('Block automatic update for major version');
                }
            } else if (updateInfo.apps) {
                debug('Starting app update to %j', updateInfo.apps);
                apps.autoupdateApps(updateInfo.apps, AUDIT_SOURCE, NOOP_CALLBACK);
            } else {
                debug('No auto updates available');
            }
        },
        start: true,
        timeZone: gJobs.boxUpdateCheckerJob.cronTime.zone // hack
    });
}

function dynamicDNSChanged(enabled) {
    assert.strictEqual(typeof enabled, 'boolean');
    assert(gJobs.boxUpdateCheckerJob);

    debug('Dynamic DNS setting changed to %s', enabled);

    if (enabled) {
        gJobs.dynamicDNS = new CronJob({
            cronTime: '00 */10 * * * *',
            onTick: cloudron.refreshDNS,
            start: true,
            timeZone: gJobs.boxUpdateCheckerJob.cronTime.zone // hack
        });
    } else {
        if (gJobs.dynamicDNS) gJobs.dynamicDNS.stop();
        gJobs.dynamicDNS = null;
    }
}

function uninitialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    settings.events.removeListener(settings.TIME_ZONE_KEY, recreateJobs);
    settings.events.removeListener(settings.AUTOUPDATE_PATTERN_KEY, autoupdatePatternChanged);
    settings.events.removeListener(settings.DYNAMIC_DNS_KEY, dynamicDNSChanged);

    for (var job in gJobs) {
        if (!gJobs[job]) continue;
        gJobs[job].stop();
        gJobs[job] = null;
    }

    callback();
}
