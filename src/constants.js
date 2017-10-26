'use strict';

exports = module.exports = {
    API_LOCATION: 'api', // this is unused but reserved for future use (#403)
    SMTP_LOCATION: 'smtp',
    IMAP_LOCATION: 'imap',
    POSTMAN_LOCATION: 'postman', // used in dovecot bounces

    // These are combined into one array because users and groups become mailboxes
    RESERVED_NAMES: [
        // Reserved usernames
        // https://github.com/gogits/gogs/blob/52c8f691630548fe091d30bcfe8164545a05d3d5/models/repo.go#L393
        'admin', 'no-reply', 'postmaster', 'mailer-daemon', // apps like wordpress, gogs don't like these

        // Reserved groups
        'admins', 'users'         // ldap code uses 'users' pseudo group
    ],

    ADMIN_NAME: 'Settings',

    ADMIN_CLIENT_ID: 'webadmin', // oauth client id
    ADMIN_APPID: 'admin', // admin appid (settingsdb)

    ADMIN_GROUP_ID: 'admin',

    NGINX_ADMIN_CONFIG_FILE_NAME: 'admin.conf',

    GHOST_USER_FILE: '/tmp/cloudron_ghost.json',

    DEFAULT_TOKEN_EXPIRATION: 7 * 24 * 60 * 60 * 1000, // 1 week

    DEFAULT_MEMORY_LIMIT: (256 * 1024 * 1024), // see also client.js

    DEMO_USERNAME: 'cloudron',

    DKIM_SELECTOR: 'cloudron',

    AUTOUPDATE_PATTERN_NEVER: 'never'
};

