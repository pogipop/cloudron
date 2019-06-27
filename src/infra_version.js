'use strict';

// WARNING WARNING WARNING WARNING WARNING WARNING WARNING WARNING
// These constants are used in the installer script as well
// Do not require anything here!

exports = module.exports = {
    // a version change recreates all containers with latest docker config
    'version': '48.15.0',

    'baseImages': [
        { repo: 'cloudron/base', tag: 'cloudron/base:1.0.0@sha256:147a648a068a2e746644746bbfb42eb7a50d682437cead3c67c933c546357617' }
    ],

    // a major version bump in the db containers will trigger the restore logic that uses the db dumps
    // docker inspect --format='{{index .RepoDigests 0}}' $IMAGE to get the sha256
    'images': {
        'mysql': { repo: 'cloudron/mysql', tag: 'cloudron/mysql:2.0.2@sha256:a28320f313785816be60e3f865e09065504170a3d20ed37de675c719b32b01eb' },
        'postgresql': { repo: 'cloudron/postgresql', tag: 'cloudron/postgresql:2.0.2@sha256:6dcee0731dfb9b013ed94d56205eee219040ee806c7e251db3b3886eaa4947ff' },
        'mongodb': { repo: 'cloudron/mongodb', tag: 'cloudron/mongodb:2.1.0@sha256:6d1bf221cfe6124957e2c58b57c0a47214353496009296acb16adf56df1da9d5' },
        'redis': { repo: 'cloudron/redis', tag: 'cloudron/redis:2.0.0@sha256:8a88dd334b62b578530a014ca1a2425a54cb9df1e475f5d3a36806e5cfa22121' },
        'mail': { repo: 'cloudron/mail', tag: 'cloudron/mail:2.3.1@sha256:9693e3ae42a12a7ac8cf5df94d828d46f5b22b4e2e1c7d1bc614d6ee2a22c365' },
        'graphite': { repo: 'cloudron/graphite', tag: 'cloudron/graphite:2.0.2@sha256:454f035d60b768153d4f31210380271b5ba1c09367c9d95c7fa37f9e39d2f59c' },
        'sftp': { repo: 'cloudron/sftp', tag: 'cloudron/sftp:0.1.0@sha256:e177c5bf5f38c84ce1dea35649c22a1b05f96eec67a54a812c5a35e585670f0f' }
    }
};
