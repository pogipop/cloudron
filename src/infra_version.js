'use strict';

// WARNING WARNING WARNING WARNING WARNING WARNING WARNING WARNING
// These constants are used in the installer script as well
// Do not require anything here!

exports = module.exports = {
    // a version change recreates all containers with latest docker config
    'version': '48.14.0',

    'baseImages': [
        { repo: 'cloudron/base', tag: 'cloudron/base:1.0.0@sha256:147a648a068a2e746644746bbfb42eb7a50d682437cead3c67c933c546357617' }
    ],

    // a major version bump in the db containers will trigger the restore logic that uses the db dumps
    // docker inspect --format='{{index .RepoDigests 0}}' $IMAGE to get the sha256
    'images': {
        'mysql': { repo: 'cloudron/mysql', tag: 'cloudron/mysql:2.0.2@sha256:a28320f313785816be60e3f865e09065504170a3d20ed37de675c719b32b01eb' },
        'postgresql': { repo: 'cloudron/postgresql', tag: 'cloudron/postgresql:2.0.2@sha256:6dcee0731dfb9b013ed94d56205eee219040ee806c7e251db3b3886eaa4947ff' },
        'mongodb': { repo: 'cloudron/mongodb', tag: 'cloudron/mongodb:2.0.2@sha256:95e006390ddce7db637e1672eb6f3c257d3c2652747424f529b1dee3cbe6728c' },
        'redis': { repo: 'cloudron/redis', tag: 'cloudron/redis:2.0.0@sha256:8a88dd334b62b578530a014ca1a2425a54cb9df1e475f5d3a36806e5cfa22121' },
        'mail': { repo: 'cloudron/mail', tag: 'cloudron/mail:2.2.0@sha256:20e4d2508dcf712eb56481067993ae39bf541d793d44f99f6a41d630ad941d9e' },
        'graphite': { repo: 'cloudron/graphite', tag: 'cloudron/graphite:2.0.2@sha256:454f035d60b768153d4f31210380271b5ba1c09367c9d95c7fa37f9e39d2f59c' },
        'sftp': { repo: 'cloudron/sftp', tag: 'cloudron/sftp:0.0.1@sha256:2e620f62cf2868ee29eafdc574eca012990a21898f77ab47f2f86e5788134f20' }
    }
};
