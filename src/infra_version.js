'use strict';

// WARNING WARNING WARNING WARNING WARNING WARNING WARNING WARNING
// These constants are used in the installer script as well
// Do not require anything here!

exports = module.exports = {
    // a major version makes all apps restore from backup. #451 must be fixed before we do this.
    // a minor version makes all apps re-configure themselves
    'version': '48.12.0',

    'baseImages': [ 'cloudron/base:0.10.0', 'cloudron/base:1.0.0' ],

    // Note that if any of the databases include an upgrade, bump the infra version above
    // This is because we upgrade using dumps instead of mysql_upgrade, pg_upgrade etc
    // docker inspect --format='{{index .RepoDigests 0}}' $IMAGE to get the sha256
    'images': {
        'mysql': { repo: 'cloudron/mysql', tag: 'cloudron/mysql:2.0.0@sha256:1c177c3fa079695aea13cec6daf52b772f400022131f31e8da237f55d683d9f4' },
        'postgresql': { repo: 'cloudron/postgresql', tag: 'cloudron/postgresql:2.0.0@sha256:ef357c0319e50fcc64cc5fa19e31e73b0632e48073d44024399fe93fbe8aaf82' },
        'mongodb': { repo: 'cloudron/mongodb', tag: 'cloudron/mongodb:2.0.0@sha256:ef77e926811b775dd2b208ec619c902c22cb583838663cdd901811dacfbedbb9' },
        'redis': { repo: 'cloudron/redis', tag: 'cloudron/redis:2.0.0@sha256:8a88dd334b62b578530a014ca1a2425a54cb9df1e475f5d3a36806e5cfa22121' },
        'mail': { repo: 'cloudron/mail', tag: 'cloudron/mail:2.0.0@sha256:eb2463d768cccb681c404eae6d06516688dc04d8b64cbc49b3b834b78cef0a61' },
        'graphite': { repo: 'cloudron/graphite', tag: 'cloudron/graphite:2.0.0@sha256:454f035d60b768153d4f31210380271b5ba1c09367c9d95c7fa37f9e39d2f59c' }
    }
};
