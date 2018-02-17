'use strict';

// WARNING WARNING WARNING WARNING WARNING WARNING WARNING WARNING
// These constants are used in the installer script as well
// Do not require anything here!

exports = module.exports = {
    // a major version makes all apps restore from backup. #451 must be fixed before we do this.
    // a minor version makes all apps re-configure themselves
    'version': '48.9.0',

    'baseImages': [ 'cloudron/base:0.10.0' ],

    // Note that if any of the databases include an upgrade, bump the infra version above
    // This is because we upgrade using dumps instead of mysql_upgrade, pg_upgrade etc
    'images': {
        'mysql': { repo: 'cloudron/mysql', tag: 'cloudron/mysql:1.0.0' },
        'postgresql': { repo: 'cloudron/postgresql', tag: 'cloudron/postgresql:1.0.0' },
        'mongodb': { repo: 'cloudron/mongodb', tag: 'cloudron/mongodb:1.0.1' },
        'redis': { repo: 'cloudron/redis', tag: 'cloudron/redis:1.0.0' },
        'mail': { repo: 'cloudron/mail', tag: 'cloudron/mail:1.1.0' },
        'graphite': { repo: 'cloudron/graphite', tag: 'cloudron/graphite:1.0.0' }
    }
};
