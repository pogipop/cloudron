'use strict';

// WARNING WARNING WARNING WARNING WARNING WARNING WARNING WARNING
// These constants are used in the installer script as well
// Do not require anything here!

exports = module.exports = {
    // a version change recreates all containers with latest docker config
    'version': '48.12.0',

    'baseImages': [ 'cloudron/base:1.0.0@sha256:147a648a068a2e746644746bbfb42eb7a50d682437cead3c67c933c546357617' ],

    // a major version bump in the db containers will trigger the restore logic that uses the db dumps
    // docker inspect --format='{{index .RepoDigests 0}}' $IMAGE to get the sha256
    'images': {
        'mysql': { repo: 'cloudron/mysql', tag: 'cloudron/mysql:2.0.0@sha256:56253ab5f98e9d3cfd9b0aa65836c2b04e3f42f480b9dcd82f2f79cb762c0fad' },
        'postgresql': { repo: 'cloudron/postgresql', tag: 'cloudron/postgresql:2.0.1@sha256:3cb04e1ca7fb3ac402eb0603b4cbaec8bacc531b40f903655ec7b979c757a8d7' },
        'mongodb': { repo: 'cloudron/mongodb', tag: 'cloudron/mongodb:2.0.0@sha256:910112e46cb066505cf49b86efee68858714cabe8f55c605f30eeb83fb894760' },
        'redis': { repo: 'cloudron/redis', tag: 'cloudron/redis:2.0.0@sha256:8a88dd334b62b578530a014ca1a2425a54cb9df1e475f5d3a36806e5cfa22121' },
        'mail': { repo: 'cloudron/mail', tag: 'cloudron/mail:2.0.0@sha256:3c0fbb2a042ac471940ac3e9f6ffa900c8a294941fb7de509b2e3309b09fbffd' },
        'graphite': { repo: 'cloudron/graphite', tag: 'cloudron/graphite:2.0.0@sha256:454f035d60b768153d4f31210380271b5ba1c09367c9d95c7fa37f9e39d2f59c' }
    }
};
