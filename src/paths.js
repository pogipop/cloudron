'use strict';

var config = require('./config.js'),
    path = require('path');

// keep these values in sync with start.sh
exports = module.exports = {
    CLOUDRON_DEFAULT_AVATAR_FILE: path.join(__dirname + '/../assets/avatar.png'),
    INFRA_VERSION_FILE: path.join(config.baseDir(), 'data/INFRA_VERSION'),

    DATA_DIR: path.join(config.baseDir(), 'data'),
    BOX_DATA_DIR: path.join(config.baseDir(), 'boxdata'),

    ACME_CHALLENGES_DIR: path.join(config.baseDir(), 'data/acme'),
    ADDON_CONFIG_DIR: path.join(config.baseDir(), 'data/addons'),
    COLLECTD_APPCONFIG_DIR: path.join(config.baseDir(), 'data/collectd/collectd.conf.d'),
    MAIL_DATA_DIR: path.join(config.baseDir(), 'data/mail'),
    NGINX_CONFIG_DIR: path.join(config.baseDir(), 'data/nginx'),
    NGINX_APPCONFIG_DIR: path.join(config.baseDir(), 'data/nginx/applications'),
    NGINX_CERT_DIR: path.join(config.baseDir(), 'data/nginx/cert'),

    // this is not part of appdata because an icon may be set before install
    ACME_ACCOUNT_KEY_FILE: path.join(config.baseDir(), 'boxdata/acme/acme.key'),
    APP_ICONS_DIR: path.join(config.baseDir(), 'boxdata/appicons'),
    APP_CERTS_DIR: path.join(config.baseDir(), 'boxdata/certs'),
    CLOUDRON_AVATAR_FILE: path.join(config.baseDir(), 'boxdata/avatar.png'),
    FIRST_RUN_FILE: path.join(config.baseDir(), 'boxdata/first_run'),
    UPDATE_CHECKER_FILE: path.join(config.baseDir(), 'boxdata/updatechecker.json')
};
