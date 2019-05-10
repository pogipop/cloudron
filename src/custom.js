'use strict';

let debug = require('debug')('box:features'),
    lodash = require('lodash'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    yaml = require('js-yaml');

exports = module.exports = {
    uiSpec: uiSpec,
    supportEmail: supportEmail,
    alertsEmail: alertsEmail,
    sendAlertsToCloudronAdmins: sendAlertsToCloudronAdmins
};

const DEFAULT = {
    features: {
        configureBackup: true,
        dynamicDns: true,
        subscription: true,
        remoteSupport: true
    },
    support: {
        email: 'support@cloudron.io'
    },
    alerts: {
        email: '',
        notifyCloudronAdmins: false
    }
};

const gCustom = (function () {
    try {
        if (!safe.fs.existsSync(paths.CUSTOM_FILE)) return DEFAULT;
        const c = yaml.safeLoad(safe.fs.readFileSync(paths.CUSTOM_FILE, 'utf8'));
        return lodash.merge({}, DEFAULT, c);
    } catch (e) {
        debug(`Error loading features file from ${paths.CUSTOM_FILE} : ${e.message}`);
        return DEFAULT;
    }
})();

function uiSpec() {
    return {
        dynamicDns: gCustom.features.dynamicDns,
        remoteSupport: gCustom.features.remoteSupport,
        subscription: gCustom.features.subscription,
        configureBackup: gCustom.features.configureBackup
    };
}

function supportEmail() {
    return gCustom.support.email;
}

function alertsEmail() {
    return gCustom.alerts.email;
}

function sendAlertsToCloudronAdmins() {
    return gCustom.alerts.notifyCloudronAdmins;
}
