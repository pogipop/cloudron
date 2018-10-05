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
        'mysql': { repo: 'cloudron/mysql', tag: 'cloudron/mysql:2.0.1@sha256:f6a0b051cff3593fd9e4bf55158d7107fb2a3f384a9a9a192ed65a58ed5ee6b7' },
        'postgresql': { repo: 'cloudron/postgresql', tag: 'cloudron/postgresql:2.0.2@sha256:b9de4436e64266df5ddf024cb7fb0ab3213d42c7827117f693e7407647947b9f' },
        'mongodb': { repo: 'cloudron/mongodb', tag: 'cloudron/mongodb:2.0.1@sha256:18bf7bc0032a5867a34b507532744adddc3b1c5e8c0bddca2b9ae5d33bebdecb' },
        'redis': { repo: 'cloudron/redis', tag: 'cloudron/redis:2.0.1@sha256:ac936cecbbdda8dc25d3ff08e958282190b96538628f10ad5bb55ae513a043b1' },
        'mail': { repo: 'cloudron/mail', tag: 'cloudron/mail:1.5.0@sha256:2fa6193aa719536b958ebe5aa228c08205b1f85325b79c19177a8c3d88239d4a' },
        'graphite': { repo: 'cloudron/graphite', tag: 'cloudron/graphite:1.0.0@sha256:196bf1d19782a015b361da48d06ba1017b3d04b4256d93fbb9c0b50599f69f5d' }
    }
};
