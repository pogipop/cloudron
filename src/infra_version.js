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
        'mysql': { repo: 'cloudron/mysql', tag: 'cloudron/mysql:2.0.1@sha256:42c861338d93beadc11438031ad7f68a10b1582fc27c8432173910d6b4f0e15d' },
        'postgresql': { repo: 'cloudron/postgresql', tag: 'cloudron/postgresql:2.0.1@sha256:a40096896960594411864aac1890e2a883639d6df810c2ae7b720ffa52be3681' },
        'mongodb': { repo: 'cloudron/mongodb', tag: 'cloudron/mongodb:2.0.1@sha256:b320fdea0d256fca73de40370c1029e2624c52620ec178716f59db152aef2d15' },
        'redis': { repo: 'cloudron/redis', tag: 'cloudron/redis:2.0.1@sha256:ac936cecbbdda8dc25d3ff08e958282190b96538628f10ad5bb55ae513a043b1' },
        'mail': { repo: 'cloudron/mail', tag: 'cloudron/mail:1.4.0@sha256:28e65b446569a324f4b28e920d43ac9723f9aa9699a629bec7368a2a74669f88' },
        'graphite': { repo: 'cloudron/graphite', tag: 'cloudron/graphite:1.0.0@sha256:196bf1d19782a015b361da48d06ba1017b3d04b4256d93fbb9c0b50599f69f5d' }
    }
};
