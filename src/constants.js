'use strict';

let fs = require('fs'),
    path = require('path');

const CLOUDRON = process.env.BOX_ENV === 'cloudron',
    TEST = process.env.BOX_ENV === 'test';

exports = module.exports = {
    SMTP_LOCATION: 'smtp',
    IMAP_LOCATION: 'imap',

    // These are combined into one array because users and groups become mailboxes
    RESERVED_NAMES: [
        // Reserved usernames
        // https://github.com/gogits/gogs/blob/52c8f691630548fe091d30bcfe8164545a05d3d5/models/repo.go#L393
        // apps like wordpress, gogs don't like these
        // postmaster is used in dovecot and haraka
        'admin', 'no-reply', 'postmaster', 'mailer-daemon',

        // Reserved groups
        'admins', 'users'         // ldap code uses 'users' pseudo group
    ],

    ADMIN_LOCATION: 'my',

    PORT: CLOUDRON ? 3000 : 5454,
    INTERNAL_SMTP_PORT: 2525, // this value comes from the mail container
    SYSADMIN_PORT: 3001,
    LDAP_PORT: 3002,
    DOCKER_PROXY_PORT: 3003,

    NGINX_DEFAULT_CONFIG_FILE_NAME: 'default.conf',

    GHOST_USER_FILE: '/tmp/cloudron_ghost.json',

    DEFAULT_TOKEN_EXPIRATION: 7 * 24 * 60 * 60 * 1000, // 1 week

    DEFAULT_MEMORY_LIMIT: (256 * 1024 * 1024), // see also client.js

    DEMO_USERNAME: 'cloudron',

    AUTOUPDATE_PATTERN_NEVER: 'never',

    SECRET_PLACEHOLDER: String.fromCharCode(0x25CF).repeat(8),

    CLOUDRON: CLOUDRON,
    TEST: TEST,

    VERSION: process.env.BOX_ENV === 'cloudron' ? fs.readFileSync(path.join(__dirname, '../VERSION'), 'utf8').trim() : '4.2.0-test'
};

