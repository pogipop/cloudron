'use strict';

let debug = require('debug')('box:features'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    yaml = require('js-yaml');

exports = module.exports = {
    features: features,
    supportEmail: supportEmail,
    alertsEmail: alertsEmail,
    sendAlertsToCloudronAdmins: sendAlertsToCloudronAdmins
};

const gCustom = (function () {
    try {
        if (!safe.fs.existsSync(paths.CUSTOM_FILE)) return {};
        return yaml.safeLoad(safe.fs.readFileSync(paths.CUSTOM_FILE, 'utf8'));
    } catch (e) {
        debug(`Error loading features file from ${paths.CUSTOM_FILE} : ${e.message}`);
        return {};
    }
})();

function features() {
    return {
        dynamicDns: safe.query(gCustom, 'features.dynamicDns', true),
        remoteSupport: safe.query(gCustom, 'features.remoteSupport', true),
        subscription: safe.query(gCustom, 'features.subscription', true),
        configureBackup: safe.query(gCustom, 'features.configureBackup', true)
    };
}

function supportEmail() {
    return safe.query(gCustom, 'support.email', 'support@cloudron.io');
}

function alertsEmail() {
    return safe.query(gCustom, 'alerts.email', '');
}

function sendAlertsToCloudronAdmins() {
    return safe.query(gCustom, 'alerts.notifyCloudronAdmins', true);
}
