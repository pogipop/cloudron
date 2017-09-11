'use strict';

var config = require('./config.js'),
    path = require('path');

// keep these values in sync with start.sh
exports = module.exports = {
    CLOUDRON_DEFAULT_AVATAR_FILE: path.join(__dirname + '/../assets/avatar.png'),
    INFRA_VERSION_FILE: path.join(config.baseDir(), 'platformdata/INFRA_VERSION'),

    OLD_DATA_DIR: path.join(config.baseDir(), 'data'),
    PLATFORM_DATA_DIR: path.join(config.baseDir(), 'platformdata'),
    APPS_DATA_DIR: path.join(config.baseDir(), 'appsdata'),
    BOX_DATA_DIR: path.join(config.baseDir(), 'boxdata'),

    ACME_CHALLENGES_DIR: path.join(config.baseDir(), 'platformdata/acme'),
    ADDON_CONFIG_DIR: path.join(config.baseDir(), 'platformdata/addons'),
    COLLECTD_APPCONFIG_DIR: path.join(config.baseDir(), 'platformdata/collectd/collectd.conf.d'),
    LOGROTATE_CONFIG_DIR: path.join(config.baseDir(), 'platformdata/logrotate.d'),
    NGINX_CONFIG_DIR: path.join(config.baseDir(), 'platformdata/nginx'),
    NGINX_APPCONFIG_DIR: path.join(config.baseDir(), 'platformdata/nginx/applications'),
    NGINX_CERT_DIR: path.join(config.baseDir(), 'platformdata/nginx/cert'),

    // this is not part of appdata because an icon may be set before install
    APP_ICONS_DIR: path.join(config.baseDir(), 'boxdata/appicons'),
    MAIL_DATA_DIR: path.join(config.baseDir(), 'boxdata/mail'),
    ACME_ACCOUNT_KEY_FILE: path.join(config.baseDir(), 'boxdata/acme/acme.key'),
    APP_CERTS_DIR: path.join(config.baseDir(), 'boxdata/certs'),
    CLOUDRON_AVATAR_FILE: path.join(config.baseDir(), 'boxdata/avatar.png'),
    FIRST_RUN_FILE: path.join(config.baseDir(), 'boxdata/first_run'),
    UPDATE_CHECKER_FILE: path.join(config.baseDir(), 'boxdata/updatechecker.json')
};
