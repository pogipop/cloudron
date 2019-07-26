'use strict';

exports = module.exports = {
    startJobs: startJobs,

    stopJobs: stopJobs,

    handleSettingsChanged: handleSettingsChanged
};

var appHealthMonitor = require('./apphealthmonitor.js'),
    apps = require('./apps.js'),
    appstore = require('./appstore.js'),
    assert = require('assert'),
    auditSource = require('./auditsource.js'),
    backups = require('./backups.js'),
    cloudron = require('./cloudron.js'),
    constants = require('./constants.js'),
    CronJob = require('cron').CronJob,
    debug = require('debug')('box:cron'),
    dyndns = require('./dyndns.js'),
    eventlog = require('./eventlog.js'),
    janitor = require('./janitor.js'),
    scheduler = require('./scheduler.js'),
    settings = require('./settings.js'),
    updater = require('./updater.js'),
    updateChecker = require('./updatechecker.js');

var gJobs = {
    alive: null, // send periodic stats
    appAutoUpdater: null,
    boxAutoUpdater: null,
    appUpdateChecker: null,
    backup: null,
    boxUpdateChecker: null,
    systemChecks: null,
    certificateRenew: null,
    cleanupBackups: null,
    cleanupEventlog: null,
    cleanupTokens: null,
    dockerVolumeCleaner: null,
    dynamicDns: null,
    schedulerSync: null,
    appHealthMonitor: null
};

var NOOP_CALLBACK = function (error) { if (error) debug(error); };

// cron format
// Seconds: 0-59
// Minutes: 0-59
// Hours: 0-23
// Day of Month: 1-31
// Months: 0-11
// Day of Week: 0-6

function startJobs(callback) {
    assert.strictEqual(typeof callback, 'function');

    var randomHourMinute = Math.floor(60*Math.random());
    gJobs.alive = new CronJob({
        cronTime: '00 ' + randomHourMinute + ' * * * *', // every hour on a random minute
        onTick: appstore.sendAliveStatus,
        start: true
    });

    settings.getAll(function (error, allSettings) {
        if (error) return callback(error);

        recreateJobs(allSettings[settings.TIME_ZONE_KEY]);
        appAutoupdatePatternChanged(allSettings[settings.APP_AUTOUPDATE_PATTERN_KEY]);
        boxAutoupdatePatternChanged(allSettings[settings.BOX_AUTOUPDATE_PATTERN_KEY]);
        dynamicDnsChanged(allSettings[settings.DYNAMIC_DNS_KEY]);

        callback();
    });
}

function handleSettingsChanged(key, value) {
    assert.strictEqual(typeof key, 'string');

    // value is a variant
    switch (key) {
    case settings.TIME_ZONE_KEY: recreateJobs(value); break;
    case settings.APP_AUTOUPDATE_PATTERN_KEY: appAutoupdatePatternChanged(value); break;
    case settings.BOX_AUTOUPDATE_PATTERN_KEY: boxAutoupdatePatternChanged(value); break;
    case settings.DYNAMIC_DNS_KEY: dynamicDnsChanged(value); break;
    default: break;
    }
}

function recreateJobs(tz) {
    assert.strictEqual(typeof tz, 'string');

    debug('Creating jobs with timezone %s', tz);

    if (gJobs.backup) gJobs.backup.stop();
    gJobs.backup = new CronJob({
        cronTime: '00 00 */6 * * *', // check every 6 hours
        onTick: backups.ensureBackup.bind(null, auditSource.CRON, NOOP_CALLBACK),
        start: true,
        timeZone: tz
    });

    if (gJobs.systemChecks) gJobs.systemChecks.stop();
    gJobs.systemChecks = new CronJob({
        cronTime: '00 30 * * * *', // every 30 minutes. if you change this interval, change the notification messages with correct duration
        onTick: cloudron.runSystemChecks,
        start: true,
        runOnInit: true, // run system check immediately
        timeZone: tz
    });

    // randomized pattern per cloudron every hour
    var randomMinute = Math.floor(60*Math.random());

    if (gJobs.boxUpdateCheckerJob) gJobs.boxUpdateCheckerJob.stop();
    gJobs.boxUpdateCheckerJob = new CronJob({
        cronTime: '00 ' + randomMinute + ' * * * *', // once an hour
        onTick: () => updateChecker.checkBoxUpdates(NOOP_CALLBACK),
        start: true,
        timeZone: tz
    });

    if (gJobs.appUpdateChecker) gJobs.appUpdateChecker.stop();
    gJobs.appUpdateChecker = new CronJob({
        cronTime: '00 ' + randomMinute + ' * * * *', // once an hour
        onTick: () => updateChecker.checkAppUpdates(NOOP_CALLBACK),
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
        onTick: backups.startCleanupTask.bind(null, auditSource.CRON, NOOP_CALLBACK),
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
        cronTime: constants.TEST ? '*/10 * * * * *' : '00 */1 * * * *', // every minute
        onTick: scheduler.sync,
        start: true,
        timeZone: tz
    });

    if (gJobs.certificateRenew) gJobs.certificateRenew.stop();
    gJobs.certificateRenew = new CronJob({
        cronTime: '00 00 */12 * * *', // every 12 hours
        onTick: cloudron.renewCerts.bind(null, {}, auditSource.CRON, NOOP_CALLBACK),
        start: true,
        timeZone: tz
    });

    if (gJobs.appHealthMonitor) gJobs.appHealthMonitor.stop();
    gJobs.appHealthMonitor = new CronJob({
        cronTime: '*/10 * * * * *', // every 10 seconds
        onTick: appHealthMonitor.run.bind(null, 10, NOOP_CALLBACK),
        start: true,
        timeZone: tz
    });
}

function boxAutoupdatePatternChanged(pattern) {
    assert.strictEqual(typeof pattern, 'string');
    assert(gJobs.boxUpdateCheckerJob);

    debug('Box auto update pattern changed to %s', pattern);

    if (gJobs.boxAutoUpdater) gJobs.boxAutoUpdater.stop();

    if (pattern === constants.AUTOUPDATE_PATTERN_NEVER) return;

    gJobs.boxAutoUpdater = new CronJob({
        cronTime: pattern,
        onTick: function() {
            var updateInfo = updateChecker.getUpdateInfo();
            if (updateInfo.box) {
                debug('Starting autoupdate to %j', updateInfo.box);
                updater.updateToLatest({ skipBackup: false }, auditSource.CRON, NOOP_CALLBACK);
            } else {
                debug('No box auto updates available');
            }
        },
        start: true,
        timeZone: gJobs.boxUpdateCheckerJob.cronTime.zone // hack
    });
}

function appAutoupdatePatternChanged(pattern) {
    assert.strictEqual(typeof pattern, 'string');
    assert(gJobs.boxUpdateCheckerJob);

    debug('Apps auto update pattern changed to %s', pattern);

    if (gJobs.appAutoUpdater) gJobs.appAutoUpdater.stop();

    if (pattern === constants.AUTOUPDATE_PATTERN_NEVER) return;

    gJobs.appAutoUpdater = new CronJob({
        cronTime: pattern,
        onTick: function() {
            var updateInfo = updateChecker.getUpdateInfo();
            if (updateInfo.apps) {
                debug('Starting app update to %j', updateInfo.apps);
                apps.autoupdateApps(updateInfo.apps, auditSource.CRON, NOOP_CALLBACK);
            } else {
                debug('No app auto updates available');
            }
        },
        start: true,
        timeZone: gJobs.boxUpdateCheckerJob.cronTime.zone // hack
    });
}

function dynamicDnsChanged(enabled) {
    assert.strictEqual(typeof enabled, 'boolean');
    assert(gJobs.boxUpdateCheckerJob);

    debug('Dynamic DNS setting changed to %s', enabled);

    if (enabled) {
        gJobs.dynamicDns = new CronJob({
            cronTime: '00 */10 * * * *',
            onTick: dyndns.sync.bind(null, auditSource.CRON, NOOP_CALLBACK),
            start: true,
            timeZone: gJobs.boxUpdateCheckerJob.cronTime.zone // hack
        });
    } else {
        if (gJobs.dynamicDns) gJobs.dynamicDns.stop();
        gJobs.dynamicDns = null;
    }
}

function stopJobs(callback) {
    assert.strictEqual(typeof callback, 'function');

    for (var job in gJobs) {
        if (!gJobs[job]) continue;
        gJobs[job].stop();
        gJobs[job] = null;
    }

    callback();
}
