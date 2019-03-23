#### WARNING WARNING WARNING WARNING WARNING WARNING WARNING WARNING
#### This file is not used by any code and is here to document the latest schema

#### General ideas
#### Default char set is utf8 and DEFAULT COLLATE is utf8_bin. Collate affects comparisons in WHERE and ORDER
#### Strict mode is enabled
#### VARCHAR - stored as part of table row (use for strings)
#### TEXT - stored offline from table row (use for strings)
#### BLOB - stored offline from table row (use for binary data)
#### https://dev.mysql.com/doc/refman/5.0/en/storage-requirements.html
#### Times are stored in the database in UTC. And precision is seconds

# The code uses zero dates. Make sure sql_mode does NOT have NO_ZERO_DATE
# http://johnemb.blogspot.com/2014/09/adding-or-removing-individual-sql-modes.html
# SET GLOBAL sql_mode=(SELECT REPLACE(@@sql_mode,'NO_ZERO_DATE',''));

CREATE TABLE IF NOT EXISTS users(
    id VARCHAR(128) NOT NULL UNIQUE,
    username VARCHAR(254) UNIQUE,
    email VARCHAR(254) NOT NULL UNIQUE,
    password VARCHAR(1024) NOT NULL,
    salt VARCHAR(512) NOT NULL,
    createdAt VARCHAR(512) NOT NULL,
    modifiedAt VARCHAR(512) NOT NULL,
    displayName VARCHAR(512) DEFAULT "",
    fallbackEmail VARCHAR(512) DEFAULT "",
    twoFactorAuthenticationSecret VARCHAR(128) DEFAULT "",
    twoFactorAuthenticationEnabled BOOLEAN DEFAULT false,
    admin BOOLEAN DEFAULT false,

    PRIMARY KEY(id));

CREATE TABLE IF NOT EXISTS userGroups(
    id VARCHAR(128) NOT NULL UNIQUE,
    name VARCHAR(254) NOT NULL UNIQUE,
    PRIMARY KEY(id));

CREATE TABLE IF NOT EXISTS groupMembers(
    groupId VARCHAR(128) NOT NULL,
    userId VARCHAR(128) NOT NULL,
    FOREIGN KEY(groupId) REFERENCES userGroups(id),
    FOREIGN KEY(userId) REFERENCES users(id));

CREATE TABLE IF NOT EXISTS tokens(
    id VARCHAR(128) NOT NULL UNIQUE,
    name VARCHAR(64) DEFAULT "", // description
    accessToken VARCHAR(128) NOT NULL UNIQUE,
    identifier VARCHAR(128) NOT NULL, // resourceId: app id or user id
    clientId VARCHAR(128),
    scope VARCHAR(512) NOT NULL,
    expires BIGINT NOT NULL, // FIXME: make this a timestamp
    PRIMARY KEY(accessToken));

CREATE TABLE IF NOT EXISTS clients(
    id VARCHAR(128) NOT NULL UNIQUE, // prefixed with cid- to identify token easily in auth routes
    appId VARCHAR(128) NOT NULL,     // name of the client (for external apps) or id of app (for built-in apps)
    type VARCHAR(16) NOT NULL,
    clientSecret VARCHAR(512) NOT NULL,
    redirectURI VARCHAR(512) NOT NULL,
    scope VARCHAR(512) NOT NULL,
    PRIMARY KEY(id));

CREATE TABLE IF NOT EXISTS apps(
    id VARCHAR(128) NOT NULL UNIQUE,
    appStoreId VARCHAR(128) NOT NULL,
    installationState VARCHAR(512) NOT NULL,
    installationProgress TEXT,
    runState VARCHAR(512),
    health VARCHAR(128),
    healthTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, // when the app last responded
    containerId VARCHAR(128),
    manifestJson TEXT,
    httpPort INTEGER,                        // this is the nginx proxy port and not manifest.httpPort
    location VARCHAR(128) NOT NULL,
    domain VARCHAR(128) NOT NULL,
    accessRestrictionJson TEXT, // { users: [ ], groups: [ ] }
    creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, // when the app was installed
    updateTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,   // when the last app update was done
    ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, // when this db record was updated (useful for UI caching)
    memoryLimit BIGINT DEFAULT 0,
    xFrameOptions VARCHAR(512),
    sso BOOLEAN DEFAULT 1, // whether user chose to enable SSO
    debugModeJson TEXT, // options for development mode
    robotsTxt TEXT,
    enableBackup BOOLEAN DEFAULT 1, // misnomer: controls automatic daily backups
    enableAutomaticUpdate BOOLEAN DEFAULT 1,
    mailboxName VARCHAR(128), // mailbox of this app. default allocated as '.app'
    label VARCHAR(128),     // display name
    tagsJson VARCHAR(2048), // array of tags

    // the following fields do not belong here, they can be removed when we use a queue for apptask
    restoreConfigJson VARCHAR(256), // used to pass backupId to restore from to apptask
    oldConfigJson TEXT, // used to pass old config to apptask (configure, restore)
    updateConfigJson TEXT, // used to pass new config to apptask (update)

    ownerId VARCHAR(128),

    FOREIGN KEY(ownerId) REFERENCES users(id),
    PRIMARY KEY(id));

CREATE TABLE IF NOT EXISTS appPortBindings(
    hostPort INTEGER NOT NULL UNIQUE,
    type VARCHAR(8) NOT NULL DEFAULT "tcp",
    environmentVariable VARCHAR(128) NOT NULL,
    appId VARCHAR(128) NOT NULL,
    FOREIGN KEY(appId) REFERENCES apps(id),
    PRIMARY KEY(hostPort));

CREATE TABLE IF NOT EXISTS authcodes(
    authCode VARCHAR(128) NOT NULL UNIQUE,
    userId VARCHAR(128) NOT NULL,
    clientId VARCHAR(128) NOT NULL,
    expiresAt BIGINT NOT NULL, // ## FIXME: make this a timestamp
    PRIMARY KEY(authCode));

CREATE TABLE IF NOT EXISTS settings(
    name VARCHAR(128) NOT NULL UNIQUE,
    value TEXT,
    locked BOOLEAN,
    PRIMARY KEY(name));

CREATE TABLE IF NOT EXISTS appAddonConfigs(
    appId VARCHAR(128) NOT NULL,
    addonId VARCHAR(32) NOT NULL,
    name VARCHAR(128) NOT NULL,
    value VARCHAR(512) NOT NULL,
    FOREIGN KEY(appId) REFERENCES apps(id));

CREATE TABLE IF NOT EXISTS appEnvVars(
    appId VARCHAR(128) NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    FOREIGN KEY(appId) REFERENCES apps(id));

CREATE TABLE IF NOT EXISTS backups(
    id VARCHAR(128) NOT NULL,
    creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version VARCHAR(128) NOT NULL, /* app version or box version */
    type VARCHAR(16) NOT NULL, /* 'box' or 'app' */
    dependsOn TEXT, /* comma separate list of objects this backup depends on */
    state VARCHAR(16) NOT NULL,
    manifestJson TEXT, /* to validate if the app can be installed in this version of box */
    format VARCHAR(16) DEFAULT "tgz",

    PRIMARY KEY (id));

CREATE TABLE IF NOT EXISTS eventlog(
    id VARCHAR(128) NOT NULL,
    action VARCHAR(128) NOT NULL,
    source TEXT, /* { userId, username, ip }. userId can be null for cron,sysadmin */
    data TEXT, /* free flowing json based on action */
    creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id));

CREATE TABLE IF NOT EXISTS domains(
    domain VARCHAR(128) NOT NULL UNIQUE, /* if this needs to be larger, InnoDB has a limit of 767 bytes for PRIMARY KEY values! */
    zoneName VARCHAR(128) NOT NULL, /* this mostly contains the domain itself again */
    provider VARCHAR(16) NOT NULL,
    configJson TEXT, /* JSON containing the dns backend provider config */
    tlsConfigJson TEXT, /* JSON containing the tls provider config */
    locked BOOLEAN,

    PRIMARY KEY (domain))

    /* the default db collation is utf8mb4_unicode_ci but for the app table domain constraint we have to use the old one */
    CHARACTER SET utf8 COLLATE utf8_bin;

CREATE TABLE IF NOT EXISTS mail(
    domain VARCHAR(128) NOT NULL UNIQUE,

    enabled BOOLEAN DEFAULT 0, /* MDA enabled */
    mailFromValidation BOOLEAN DEFAULT 1,
    catchAllJson TEXT,
    relayJson TEXT,

    FOREIGN KEY(domain) REFERENCES domains(domain),
    PRIMARY KEY(domain))

    CHARACTER SET utf8 COLLATE utf8_bin;

/* Future fields:
   * accessRestriction - to determine who can access it. So this has foreign keys
   * quota - per mailbox quota

   NOTE: this table exists only real mailboxes. And has unique constraint to handle
   conflict with aliases and mailbox names
*/
CREATE TABLE IF NOT EXISTS mailboxes(
    name VARCHAR(128) NOT NULL,
    type VARCHAR(16) NOT NULL, /* 'mailbox', 'alias', 'list' */
    ownerId VARCHAR(128) NOT NULL, /* user id */
    aliasTarget VARCHAR(128), /* the target name type is an alias */
    membersJson TEXT, /* members of a group */
    creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    domain VARCHAR(128),

    FOREIGN KEY(domain) REFERENCES mail(domain),
    UNIQUE (name, domain));

CREATE TABLE IF NOT EXISTS subdomains(
    appId VARCHAR(128) NOT NULL,
    domain VARCHAR(128) NOT NULL,
    subdomain VARCHAR(128) NOT NULL,
    type VARCHAR(128) NOT NULL,

    FOREIGN KEY(domain) REFERENCES domains(domain),
    FOREIGN KEY(appId) REFERENCES apps(id),
    UNIQUE (subdomain, domain));

CREATE TABLE IF NOT EXISTS tasks(
    id int NOT NULL AUTO_INCREMENT,
    type VARCHAR(32) NOT NULL,
    percent INTEGER DEFAULT 0,
    message TEXT,
    errorMessage TEXT,
    result TEXT,
    creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id));

CREATE TABLE IF NOT EXISTS notifications(
    id int NOT NULL AUTO_INCREMENT,
    userId VARCHAR(128) NOT NULL,
    eventId VARCHAR(128), // reference to eventlog. can be null
    title VARCHAR(512) NOT NULL,
    message TEXT,
    acknowledged BOOLEAN DEFAULT false,
    creationTime TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id)
);

CHARACTER SET utf8 COLLATE utf8_bin;
