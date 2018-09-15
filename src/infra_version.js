'use strict';

// WARNING WARNING WARNING WARNING WARNING WARNING WARNING WARNING
// These constants are used in the installer script as well
// Do not require anything here!

exports = module.exports = {
    // a major version makes all apps restore from backup. #451 must be fixed before we do this.
    // a minor version makes all apps re-configure themselves
    'version': '48.12.0',

    'baseImages': [ 'cloudron/base:0.10.0' ],

    // Note that if any of the databases include an upgrade, bump the infra version above
    // This is because we upgrade using dumps instead of mysql_upgrade, pg_upgrade etc
    // docker inspect --format='{{index .RepoDigests 0}}' $IMAGE to get the sha256
    'images': {
        'mysql': { repo: 'cloudron/mysql', tag: 'cloudron/mysql:1.1.0' },
        'postgresql': { repo: 'cloudron/postgresql', tag: 'cloudron/postgresql:1.1.0' },
        'mongodb': { repo: 'cloudron/mongodb', tag: 'cloudron/mongodb:2.0.0@sha256:b1d8877755463cfc2c14e43d750b9e9d391e1a68814ac0d3ba0f8963e667480a' },
        'redis': { repo: 'cloudron/redis', tag: 'cloudron/redis:2.0.0@sha256:3c35702a751e2b8dfa4f7cdf41c7f899f62329a09beb09b5292b2c1bfe1f6ccb' },
        'mail': { repo: 'cloudron/mail', tag: 'cloudron/mail:1.4.0' },
        'graphite': { repo: 'cloudron/graphite', tag: 'cloudron/graphite:1.0.0@sha256:196bf1d19782a015b361da48d06ba1017b3d04b4256d93fbb9c0b50599f69f5d' }
    }
};
