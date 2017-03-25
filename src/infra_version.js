'use strict';

// WARNING WARNING WARNING WARNING WARNING WARNING WARNING WARNING
// These constants are used in the installer script as well
// Do not require anything here!

exports = module.exports = {
    // a version bump means that all app containers are recreated
    'version': 47,

    'baseImages': [ 'cloudron/base:0.10.0' ],

    // Note that if any of the databases include an upgrade, bump the infra version above
    // This is because we upgrade using dumps instead of mysql_upgrade, pg_upgrade etc
    'images': {
        'mysql': { repo: 'cloudron/mysql', tag: 'cloudron/mysql:0.14.0' },
        'postgresql': { repo: 'cloudron/postgresql', tag: 'cloudron/postgresql:0.16.0' },
        'mongodb': { repo: 'cloudron/mongodb', tag: 'cloudron/mongodb:0.12.0' },
        'redis': { repo: 'cloudron/redis', tag: 'cloudron/redis:0.11.0' },
        'mail': { repo: 'cloudron/mail', tag: 'cloudron/mail:0.30.5' },
        'graphite': { repo: 'cloudron/graphite', tag: 'cloudron/graphite:0.11.0' }
    }
};

