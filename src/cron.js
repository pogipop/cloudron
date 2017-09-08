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
    email = require('./email.js'),
    eventlog = require('./eventlog.js'),
    janitor = require('./janitor.js'),
    scheduler = require('./scheduler.js'),
    settings = require('./settings.js'),
    semver = require('semver'),
    updateChecker = require('./updatechecker.js');

var gAliveJob = null, // send periodic stats
    gAppUpdateCheckerJob = null,
    gAutoupdaterJob = null,
    gBackupJob = null,
    gBoxUpdateCheckerJob = null,
    gCertificateRenewJob = null,
    gCheckDiskSpaceJob = null,
    gCleanupBackupsJob = null,
    gCleanupEventlogJob = null,
    gCleanupTokensJob = null,
    gDockerVolumeCleanerJob = null,
    gDynamicDNSJob = null,
    gHeartbeatJob = null, // for CaaS health check
    gSchedulerSyncJob = null,
    gDigestEmailJob = null,
    gRblCheckJob = null;

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

    gHeartbeatJob = new CronJob({
        cronTime: '00 */1 * * * *', // every minute
        onTick: cloudron.sendHeartbeat,
        start: false
    });
    // hack: send the first heartbeat only after we are running for 60 seconds
    // required as we end up sending a heartbeat and then cloudron-setup reboots the server
    setTimeout(function () {
        if (!gHeartbeatJob) return; // already uninitalized
        gHeartbeatJob.start();
        cloudron.sendHeartbeat();
    }, 1000 * 60);

    var randomHourMinute = Math.floor(60*Math.random());
    gAliveJob = new CronJob({
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

    if (gBackupJob) gBackupJob.stop();
    gBackupJob = new CronJob({
        cronTime: '00 00 */6 * * *', // every 6 hours. backups.ensureBackup() will only trigger a backup once per day
        onTick: backups.ensureBackup.bind(null, AUDIT_SOURCE, NOOP_CALLBACK),
        start: true,
        timeZone: tz
    });

    if (gCheckDiskSpaceJob) gCheckDiskSpaceJob.stop();
    gCheckDiskSpaceJob = new CronJob({
        cronTime: '00 30 */4 * * *', // every 4 hours
        onTick: cloudron.checkDiskSpace,
        start: true,
        timeZone: tz
    });

    // randomized pattern per cloudron every hour
    var randomMinute = Math.floor(60*Math.random());

    if (gBoxUpdateCheckerJob) gBoxUpdateCheckerJob.stop();
    gBoxUpdateCheckerJob = new CronJob({
        cronTime: '00 ' + randomMinute + ' * * * *', // once an hour
        onTick: updateChecker.checkBoxUpdates,
        start: true,
        timeZone: tz
    });

    if (gAppUpdateCheckerJob) gAppUpdateCheckerJob.stop();
    gAppUpdateCheckerJob = new CronJob({
        cronTime: '00 ' + randomMinute + ' * * * *', // once an hour
        onTick: updateChecker.checkAppUpdates,
        start: true,
        timeZone: tz
    });

    if (gCleanupTokensJob) gCleanupTokensJob.stop();
    gCleanupTokensJob = new CronJob({
        cronTime: '00 */30 * * * *', // every 30 minutes
        onTick: janitor.cleanupTokens,
        start: true,
        timeZone: tz
    });

    if (gCleanupBackupsJob) gCleanupBackupsJob.stop();
    gCleanupBackupsJob = new CronJob({
        cronTime: '00 45 */6 * * *', // every 6 hours. try not to overlap with ensureBackup job
        onTick: backups.cleanup,
        start: true,
        timeZone: tz
    });

    if (gCleanupEventlogJob) gCleanupEventlogJob.stop();
    gCleanupEventlogJob = new CronJob({
        cronTime: '00 */30 * * * *', // every 30 minutes
        onTick: eventlog.cleanup,
        start: true,
        timeZone: tz
    });

    if (gDockerVolumeCleanerJob) gDockerVolumeCleanerJob.stop();
    gDockerVolumeCleanerJob = new CronJob({
        cronTime: '00 00 */12 * * *', // every 12 hours
        onTick: janitor.cleanupDockerVolumes,
        start: true,
        timeZone: tz
    });

    if (gSchedulerSyncJob) gSchedulerSyncJob.stop();
    gSchedulerSyncJob = new CronJob({
        cronTime: config.TEST ? '*/10 * * * * *' : '00 */1 * * * *', // every minute
        onTick: scheduler.sync,
        start: true,
        timeZone: tz
    });

    if (gCertificateRenewJob) gCertificateRenewJob.stop();
    gCertificateRenewJob = new CronJob({
        cronTime: '00 00 */12 * * *', // every 12 hours
        onTick: certificates.renewAll.bind(null, AUDIT_SOURCE, NOOP_CALLBACK),
        start: true,
        timeZone: tz
    });

    if (gDigestEmailJob) gDigestEmailJob.stop();
    gDigestEmailJob = new CronJob({
        cronTime: '00 00 00 * * 3', // every wednesday
        onTick: digest.maybeSend,
        start: true,
        timeZone: tz
    });

    if (gRblCheckJob) gRblCheckJob.stop();
    gRblCheckJob = new CronJob({
        cronTime: '00 00 5 * * *', // every day
        onTick: email.checkRblStatus,
        start: true,
        timeZone: tz
    });
}

function autoupdatePatternChanged(pattern) {
    assert.strictEqual(typeof pattern, 'string');
    assert(gBoxUpdateCheckerJob);

    debug('Auto update pattern changed to %s', pattern);

    if (gAutoupdaterJob) gAutoupdaterJob.stop();

    if (pattern === constants.AUTOUPDATE_PATTERN_NEVER) return;

    gAutoupdaterJob = new CronJob({
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
        timeZone: gBoxUpdateCheckerJob.cronTime.zone // hack
    });
}

function dynamicDNSChanged(enabled) {
    assert.strictEqual(typeof enabled, 'boolean');
    assert(gBoxUpdateCheckerJob);

    debug('Dynamic DNS setting changed to %s', enabled);

    if (enabled) {
        gDynamicDNSJob = new CronJob({
            cronTime: '00 */10 * * * *',
            onTick: cloudron.refreshDNS,
            start: true,
            timeZone: gBoxUpdateCheckerJob.cronTime.zone // hack
        });
    } else {
        if (gDynamicDNSJob) gDynamicDNSJob.stop();
        gDynamicDNSJob = null;
    }
}

function uninitialize(callback) {
    assert.strictEqual(typeof callback, 'function');

    settings.events.removeListener(settings.TIME_ZONE_KEY, recreateJobs);
    settings.events.removeListener(settings.AUTOUPDATE_PATTERN_KEY, autoupdatePatternChanged);

    if (gAutoupdaterJob) gAutoupdaterJob.stop();
    gAutoupdaterJob = null;

    if (gBoxUpdateCheckerJob) gBoxUpdateCheckerJob.stop();
    gBoxUpdateCheckerJob = null;

    if (gAppUpdateCheckerJob) gAppUpdateCheckerJob.stop();
    gAppUpdateCheckerJob = null;

    if (gHeartbeatJob) gHeartbeatJob.stop();
    gHeartbeatJob = null;

    if (gAliveJob) gAliveJob.stop();
    gAliveJob = null;

    if (gBackupJob) gBackupJob.stop();
    gBackupJob = null;

    if (gCleanupTokensJob) gCleanupTokensJob.stop();
    gCleanupTokensJob = null;

    if (gCleanupBackupsJob) gCleanupBackupsJob.stop();
    gCleanupBackupsJob = null;

    if (gCleanupEventlogJob) gCleanupEventlogJob.stop();
    gCleanupEventlogJob = null;

    if (gDockerVolumeCleanerJob) gDockerVolumeCleanerJob.stop();
    gDockerVolumeCleanerJob = null;

    if (gSchedulerSyncJob) gSchedulerSyncJob.stop();
    gSchedulerSyncJob = null;

    if (gCertificateRenewJob) gCertificateRenewJob.stop();
    gCertificateRenewJob = null;

    if (gDynamicDNSJob) gDynamicDNSJob.stop();
    gDynamicDNSJob = null;

    if (gDigestEmailJob) gDigestEmailJob.stop();
    gDigestEmailJob = null;

    if (gRblCheckJob) gRblCheckJob.stop();
    gRblCheckJob = null;

    callback();
}
