'use strict';

let config = require('./config.js'),
    debug = require('debug')('box:features'),
    lodash = require('lodash'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    yaml = require('js-yaml');

exports = module.exports = {
    uiSpec: uiSpec,
    spec: spec
};

const DEFAULT_SPEC = {
    appstore: {
        blacklist: [],
        whitelist: null // null imples, not set. this is an object and not an array
    },
    backups: {
        configurable: true
    },
    domains: {
        dynamicDns: true,
        changeDashboardDomain: true
    },
    subscription: {
        configurable: true
    },
    support: {
        email: 'support@cloudron.io',
        remoteSupport: true,
        ticketFormBody:
            'Use this form to open support tickets. You can also write directly to [support@cloudron.io](mailto:support@cloudron.io).\n\n'
            + `* [Knowledge Base & App Docs](${config.webServerOrigin()}/documentation/apps/?support_view)\n`
            + `* [Custom App Packaging & API](${config.webServerOrigin()}/developer/packaging/?support_view)\n`
            + '* [Forum](https://forum.cloudron.io/)\n\n',
        submitTickets: true
    },
    alerts: {
        email: '',
        notifyCloudronAdmins: false
    },
    footer: {
        body: '&copy; 2019 [Cloudron](https://cloudron.io) [Forum <i class="fa fa-comments"></i>](https://forum.cloudron.io)'
    }
};

const gSpec = (function () {
    try {
        if (!safe.fs.existsSync(paths.CUSTOM_FILE)) return DEFAULT_SPEC;
        const c = yaml.safeLoad(safe.fs.readFileSync(paths.CUSTOM_FILE, 'utf8'));
        return lodash.merge({}, DEFAULT_SPEC, c);
    } catch (e) {
        debug(`Error loading features file from ${paths.CUSTOM_FILE} : ${e.message}`);
        return DEFAULT_SPEC;
    }
})();

// flags sent to the UI. this is separate because we have values that are secret to the backend
function uiSpec() {
    return gSpec;
}

function spec() {
    return gSpec;
}