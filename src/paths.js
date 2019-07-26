'use strict';

var constants = require('./constants.js'),
    path = require('path');

function baseDir() {
    const homeDir = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
    if (constants.CLOUDRON) return homeDir;
    if (constants.TEST) return path.join(homeDir, '.cloudron_test');
    // cannot reach
}

// keep these values in sync with start.sh
exports = module.exports = {
    baseDir: baseDir,

    CLOUDRON_DEFAULT_AVATAR_FILE: path.join(__dirname + '/../assets/avatar.png'),
    INFRA_VERSION_FILE: path.join(baseDir(), 'platformdata/INFRA_VERSION'),

    LICENSE_FILE: '/etc/cloudron/LICENSE',
    PROVIDER_FILE: '/etc/cloudron/PROVIDER',

    PLATFORM_DATA_DIR: path.join(baseDir(), 'platformdata'),
    APPS_DATA_DIR: path.join(baseDir(), 'appsdata'),
    BOX_DATA_DIR: path.join(baseDir(), 'boxdata'),

    CUSTOM_FILE: path.join(baseDir(), 'boxdata/custom.yml'),

    ACME_CHALLENGES_DIR: path.join(baseDir(), 'platformdata/acme'),
    ADDON_CONFIG_DIR: path.join(baseDir(), 'platformdata/addons'),
    COLLECTD_APPCONFIG_DIR: path.join(baseDir(), 'platformdata/collectd/collectd.conf.d'),
    LOGROTATE_CONFIG_DIR: path.join(baseDir(), 'platformdata/logrotate.d'),
    NGINX_CONFIG_DIR: path.join(baseDir(), 'platformdata/nginx'),
    NGINX_APPCONFIG_DIR: path.join(baseDir(), 'platformdata/nginx/applications'),
    NGINX_CERT_DIR: path.join(baseDir(), 'platformdata/nginx/cert'),
    BACKUP_INFO_DIR: path.join(baseDir(), 'platformdata/backup'),
    UPDATE_DIR: path.join(baseDir(), 'platformdata/update'),
    SNAPSHOT_INFO_FILE: path.join(baseDir(), 'platformdata/backup/snapshot-info.json'),
    DYNDNS_INFO_FILE: path.join(baseDir(), 'platformdata/dyndns-info.json'),

    // this is not part of appdata because an icon may be set before install
    APP_ICONS_DIR: path.join(baseDir(), 'boxdata/appicons'),
    MAIL_DATA_DIR: path.join(baseDir(), 'boxdata/mail'),
    ACME_ACCOUNT_KEY_FILE: path.join(baseDir(), 'boxdata/acme/acme.key'),
    APP_CERTS_DIR: path.join(baseDir(), 'boxdata/certs'),
    CLOUDRON_AVATAR_FILE: path.join(baseDir(), 'boxdata/avatar.png'),
    UPDATE_CHECKER_FILE: path.join(baseDir(), 'boxdata/updatechecker.json'),

    LOG_DIR: path.join(baseDir(), 'platformdata/logs'),
    TASKS_LOG_DIR: path.join(baseDir(), 'platformdata/logs/tasks'),
    CRASH_LOG_DIR: path.join(baseDir(), 'platformdata/logs/crash'),

    // this pattern is for the cloudron logs API route to work
    BACKUP_LOG_FILE: path.join(baseDir(), 'platformdata/logs/backup/app.log'),
    UPDATER_LOG_FILE: path.join(baseDir(), 'platformdata/logs/updater/app.log')
};
