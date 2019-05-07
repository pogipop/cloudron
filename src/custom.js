'use strict';

let debug = require('debug')('box:features'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    yaml = require('js-yaml');

exports = module.exports = {
    features: features,
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
        remoteSupport: safe.query(gCustom, 'features.support.remote', true),
        subscription: safe.query(gCustom, 'features.subscription', true),
        configureBackup: safe.query(gCustom, 'features.configureBackup', true)
    };
}
