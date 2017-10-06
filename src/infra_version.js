'use strict';

// WARNING WARNING WARNING WARNING WARNING WARNING WARNING WARNING
// These constants are used in the installer script as well
// Do not require anything here!

exports = module.exports = {
    // a major version makes all apps restore from backup. #451 must be fixed before we do this.
    // a minor version makes all apps re-configure themselves
    'version': '48.6.0',

    'baseImages': [ 'cloudron/base:0.10.0' ],

    // Note that if any of the databases include an upgrade, bump the infra version above
    // This is because we upgrade using dumps instead of mysql_upgrade, pg_upgrade etc
    'images': {
        'mysql': { repo: 'cloudron/mysql', tag: 'cloudron/mysql:0.18.0' },
        'postgresql': { repo: 'cloudron/postgresql', tag: 'cloudron/postgresql:0.17.0' },
        'mongodb': { repo: 'cloudron/mongodb', tag: 'cloudron/mongodb:0.13.0' },
        'redis': { repo: 'cloudron/redis', tag: 'cloudron/redis:0.11.0' },
        'mail': { repo: 'cloudron/mail', tag: 'cloudron/mail:0.37.2' },
        'graphite': { repo: 'cloudron/graphite', tag: 'cloudron/graphite:0.12.0' }
    }
};
