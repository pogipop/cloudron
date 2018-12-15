'use strict';

exports = module.exports = {
    start: start,
    stop: stop
};

var accesscontrol = require('./accesscontrol.js'),
    assert = require('assert'),
    async = require('async'),
    cloudron = require('./cloudron.js'),
    config = require('./config.js'),
    database = require('./database.js'),
    eventlog = require('./eventlog.js'),
    express = require('express'),
    hat = require('./hat.js'),
    http = require('http'),
    middleware = require('./middleware'),
    passport = require('passport'),
    path = require('path'),
    routes = require('./routes/index.js'),
    ws = require('ws');

var gHttpServer = null;
var gSysadminHttpServer = null;

function initializeExpressSync() {
    var app = express();
    var httpServer = http.createServer(app);

    const wsServer = new ws.Server({ noServer: true }); // in noServer mode, we have to handle 'upgrade' and call handleUpgrade

    var QUERY_LIMIT = '1mb', // max size for json and urlencoded queries (see also client_max_body_size in nginx)
        FIELD_LIMIT = 2 * 1024 * 1024; // max fields that can appear in multipart

    var REQUEST_TIMEOUT = 10000; // timeout for all requests (see also setTimeout on the httpServer)

    var json = middleware.json({ strict: true, limit: QUERY_LIMIT }), // application/json
        urlencoded = middleware.urlencoded({ extended: false, limit: QUERY_LIMIT }); // application/x-www-form-urlencoded

    app.set('views', path.join(__dirname, 'oauth2views'));
    app.set('view options', { layout: true, debug: false });
    app.set('view engine', 'ejs');
    app.set('json spaces', 2); // pretty json

    // for rate limiting
    app.enable('trust proxy');

    if (process.env.BOX_ENV !== 'test') {
        app.use(middleware.morgan('Box :method :url :status :response-time ms - :res[content-length]', {
            immediate: false,
            // only log failed requests by default
            skip: function (req, res) { return res.statusCode < 400; }
        }));
    }

    var router = new express.Router();
    router.del = router.delete; // amend router.del for readability further on

    app
        // the timeout middleware will respond with a 503. the request itself cannot be 'aborted' and will continue
        // search for req.clearTimeout in route handlers to see places where this timeout is reset
        .use(middleware.timeout(REQUEST_TIMEOUT, { respond: true }))
        .use(json)
        .use(urlencoded)
        .use(middleware.cookieParser())
        .use(middleware.cors({ origins: [ '*' ], allowCredentials: false }))
        .use(middleware.session({
            secret: hat(128), // we only use the session during oauth, and already have an in-memory session store, so we can safely change that during restarts
            resave: true,
            saveUninitialized: true,
            cookie: {
                path: '/',
                httpOnly: true,
                secure: process.env.BOX_ENV !== 'test',
                maxAge: 600000
            }
        }))
        .use(passport.initialize())
        .use(passport.session())
        .use(router)
        .use(middleware.lastMile());

    // NOTE: these limits have to be in sync with nginx limits
    var FILE_SIZE_LIMIT = '256mb', // max file size that can be uploaded (see also client_max_body_size in nginx)
        FILE_TIMEOUT = 60 * 1000; // increased timeout for file uploads (1 min)

    var multipart = middleware.multipart({ maxFieldsSize: FIELD_LIMIT, limit: FILE_SIZE_LIMIT, timeout: FILE_TIMEOUT });

    // scope middleware implicitly also adds bearer token verification
    var cloudronScope = routes.accesscontrol.scope(accesscontrol.SCOPE_CLOUDRON);
    var profileScope = routes.accesscontrol.scope(accesscontrol.SCOPE_PROFILE);
    var usersReadScope = routes.accesscontrol.scope(accesscontrol.SCOPE_USERS_READ);
    var usersManageScope = routes.accesscontrol.scope(accesscontrol.SCOPE_USERS_MANAGE);
    var appsReadScope = routes.accesscontrol.scope(accesscontrol.SCOPE_APPS_READ);
    var appsManageScope = [ routes.accesscontrol.scope(accesscontrol.SCOPE_APPS_MANAGE), routes.apps.verifyOwnership ];
    var settingsScope = routes.accesscontrol.scope(accesscontrol.SCOPE_SETTINGS);
    var mailScope = routes.accesscontrol.scope(accesscontrol.SCOPE_MAIL);
    var clientsScope = routes.accesscontrol.scope(accesscontrol.SCOPE_CLIENTS);
    var domainsReadScope = routes.accesscontrol.scope(accesscontrol.SCOPE_DOMAINS_READ);
    var domainsManageScope = routes.accesscontrol.scope(accesscontrol.SCOPE_DOMAINS_MANAGE);
    var appstoreScope = routes.accesscontrol.scope(accesscontrol.SCOPE_APPSTORE);

    const isUnmanaged = routes.accesscontrol.isUnmanaged;
    const verifyDomainLock = routes.domains.verifyDomainLock;

    // csrf protection
    var csrf = routes.oauth2.csrf();

    // public routes
    router.post('/api/v1/cloudron/setup', routes.provision.providerTokenAuth, routes.provision.setup);    // only available until no-domain
    router.post('/api/v1/cloudron/restore', routes.provision.restore);    // only available until activated
    router.post('/api/v1/cloudron/activate', routes.provision.setupTokenAuth, routes.provision.activate);
    router.get ('/api/v1/cloudron/status', routes.provision.getStatus);

    router.get ('/api/v1/cloudron/avatar', routes.settings.getCloudronAvatar); // this is a public alias for /api/v1/settings/cloudron_avatar

    // developer routes
    router.post('/api/v1/developer/login', routes.developer.login);

    // cloudron routes
    router.get ('/api/v1/cloudron/update', cloudronScope, routes.cloudron.getUpdateInfo);
    router.post('/api/v1/cloudron/update', cloudronScope, routes.cloudron.update);
    router.post('/api/v1/cloudron/prepare_dashboard_dns', cloudronScope, routes.cloudron.prepareDashboardDomain);
    router.post('/api/v1/cloudron/set_dashboard_domain', cloudronScope, routes.cloudron.setDashboardDomain);
    router.post('/api/v1/cloudron/renew_certs', cloudronScope, routes.cloudron.renewCerts);
    router.post('/api/v1/cloudron/check_for_updates', cloudronScope, routes.cloudron.checkForUpdates);
    router.get ('/api/v1/cloudron/reboot', cloudronScope, routes.cloudron.isRebootRequired);
    router.post('/api/v1/cloudron/reboot', cloudronScope, routes.cloudron.reboot);
    router.get ('/api/v1/cloudron/graphs', cloudronScope, routes.graphs.getGraphs);
    router.get ('/api/v1/cloudron/disks', cloudronScope, routes.cloudron.getDisks);
    router.get ('/api/v1/cloudron/logs/:unit', cloudronScope, routes.cloudron.getLogs);
    router.get ('/api/v1/cloudron/logstream/:unit', cloudronScope, routes.cloudron.getLogStream);
    router.get ('/api/v1/cloudron/ssh/authorized_keys', cloudronScope, isUnmanaged, routes.ssh.getAuthorizedKeys);
    router.put ('/api/v1/cloudron/ssh/authorized_keys', cloudronScope, isUnmanaged, routes.ssh.addAuthorizedKey);
    router.get ('/api/v1/cloudron/ssh/authorized_keys/:identifier', cloudronScope, isUnmanaged, routes.ssh.getAuthorizedKey);
    router.del ('/api/v1/cloudron/ssh/authorized_keys/:identifier', cloudronScope, isUnmanaged, routes.ssh.delAuthorizedKey);
    router.get ('/api/v1/cloudron/eventlog', cloudronScope, routes.eventlog.get);

    // tasks
    router.get ('/api/v1/tasks', settingsScope, routes.tasks.list);
    router.get ('/api/v1/tasks/:taskId', settingsScope, routes.tasks.get);
    router.get ('/api/v1/tasks/:taskId/logs', cloudronScope, routes.tasks.getLogs);
    router.get ('/api/v1/tasks/:taskId/logstream', cloudronScope, routes.tasks.getLogStream);
    router.post('/api/v1/tasks/:taskId/stop', settingsScope, routes.tasks.stopTask);

    // backups
    router.get ('/api/v1/backups', settingsScope, routes.backups.list);
    router.post('/api/v1/backups', settingsScope, routes.backups.startBackup);

    // config route (for dashboard)
    router.get ('/api/v1/config', profileScope, routes.cloudron.getConfig);

    // working off the user behind the provided token
    router.get ('/api/v1/profile', profileScope, routes.profile.get);
    router.post('/api/v1/profile', profileScope, routes.profile.update);
    router.post('/api/v1/profile/password', profileScope, routes.users.verifyPassword, routes.profile.changePassword);
    router.post('/api/v1/profile/twofactorauthentication', profileScope, routes.profile.setTwoFactorAuthenticationSecret);
    router.post('/api/v1/profile/twofactorauthentication/enable', profileScope, routes.profile.enableTwoFactorAuthentication);
    router.post('/api/v1/profile/twofactorauthentication/disable', profileScope, routes.users.verifyPassword, routes.profile.disableTwoFactorAuthentication);

    // user routes
    router.get ('/api/v1/users', usersReadScope, routes.users.list);
    router.post('/api/v1/users', usersManageScope, routes.users.create);
    router.get ('/api/v1/users/:userId', usersManageScope, routes.users.get); // this is manage scope because it returns non-restricted fields
    router.del ('/api/v1/users/:userId', usersManageScope, routes.users.verifyPassword, routes.users.remove);
    router.post('/api/v1/users/:userId', usersManageScope, routes.users.update);
    router.post('/api/v1/users/:userId/password', usersManageScope, routes.users.changePassword);
    router.put ('/api/v1/users/:userId/groups', usersManageScope, routes.users.setGroups);
    router.post('/api/v1/users/:userId/send_invite', usersManageScope, routes.users.sendInvite);
    router.post('/api/v1/users/:userId/create_invite', usersManageScope, routes.users.createInvite);
    router.post('/api/v1/users/:userId/transfer', usersManageScope, routes.users.transferOwnership);

    // Group management
    router.get ('/api/v1/groups', usersReadScope, routes.groups.list);
    router.post('/api/v1/groups', usersManageScope, routes.groups.create);
    router.get ('/api/v1/groups/:groupId', usersManageScope, routes.groups.get);
    router.put ('/api/v1/groups/:groupId/members', usersManageScope, routes.groups.updateMembers);
    router.post('/api/v1/groups/:groupId', usersManageScope, routes.groups.update);
    router.del ('/api/v1/groups/:groupId', usersManageScope, routes.users.verifyPassword, routes.groups.remove);

    // form based login routes used by oauth2 frame
    router.get ('/api/v1/session/login', csrf, routes.oauth2.loginForm);
    router.post('/api/v1/session/login', csrf, routes.oauth2.login);
    router.get ('/api/v1/session/logout', routes.oauth2.logout);
    router.get ('/api/v1/session/callback', routes.oauth2.sessionCallback());
    router.get ('/api/v1/session/password/resetRequest.html', csrf, routes.oauth2.passwordResetRequestSite);
    router.post('/api/v1/session/password/resetRequest', csrf, routes.oauth2.passwordResetRequest);
    router.get ('/api/v1/session/password/sent.html', routes.oauth2.passwordSentSite);
    router.get ('/api/v1/session/password/reset.html', csrf, routes.oauth2.passwordResetSite);
    router.post('/api/v1/session/password/reset', csrf, routes.oauth2.passwordReset);
    router.get ('/api/v1/session/account/setup.html', csrf, routes.oauth2.accountSetupSite);
    router.post('/api/v1/session/account/setup', csrf, routes.oauth2.accountSetup);

    // oauth2 routes
    router.get ('/api/v1/oauth/dialog/authorize', routes.oauth2.authorization());
    router.post('/api/v1/oauth/token', routes.oauth2.token());

    // client/token routes
    router.get ('/api/v1/clients', clientsScope, routes.clients.getAll);
    router.post('/api/v1/clients', clientsScope, routes.clients.add);
    router.get ('/api/v1/clients/:clientId', clientsScope, routes.clients.get);
    router.post('/api/v1/clients/:clientId', clientsScope, routes.clients.add);
    router.del ('/api/v1/clients/:clientId', clientsScope, routes.clients.del);
    router.get ('/api/v1/clients/:clientId/tokens', clientsScope, routes.clients.getTokens);
    router.post('/api/v1/clients/:clientId/tokens', clientsScope, routes.clients.addToken);
    router.del ('/api/v1/clients/:clientId/tokens', clientsScope, routes.clients.delTokens);
    router.del ('/api/v1/clients/:clientId/tokens/:tokenId', clientsScope, routes.clients.delToken);

    // app routes
    router.get ('/api/v1/apps',          appsReadScope, routes.apps.getApps);
    router.get ('/api/v1/apps/:id',      appsManageScope, routes.apps.getApp);
    router.get ('/api/v1/apps/:id/icon', routes.apps.getAppIcon);

    router.post('/api/v1/apps/install',       appsManageScope, routes.apps.installApp);
    router.post('/api/v1/apps/:id/uninstall', appsManageScope, routes.users.verifyPassword, routes.apps.uninstallApp);
    router.post('/api/v1/apps/:id/configure', appsManageScope, routes.apps.configureApp);
    router.post('/api/v1/apps/:id/update',    appsManageScope, routes.apps.updateApp);
    router.post('/api/v1/apps/:id/restore',   appsManageScope, routes.users.verifyPassword, routes.apps.restoreApp);
    router.post('/api/v1/apps/:id/backup',    appsManageScope, routes.apps.backupApp);
    router.get ('/api/v1/apps/:id/backups',   appsManageScope, routes.apps.listBackups);
    router.post('/api/v1/apps/:id/stop',      appsManageScope, routes.apps.stopApp);
    router.post('/api/v1/apps/:id/start',     appsManageScope, routes.apps.startApp);
    router.get ('/api/v1/apps/:id/logstream', appsManageScope, routes.apps.getLogStream);
    router.get ('/api/v1/apps/:id/logs',      appsManageScope, routes.apps.getLogs);
    router.get ('/api/v1/apps/:id/exec',      appsManageScope, routes.apps.exec);
    // websocket cannot do bearer authentication
    router.get ('/api/v1/apps/:id/execws',    routes.accesscontrol.websocketAuth.bind(null, [ accesscontrol.SCOPE_APPS_MANAGE ]), routes.apps.verifyOwnership, routes.apps.execWebSocket);
    router.post('/api/v1/apps/:id/clone',     appsManageScope, routes.apps.cloneApp);
    router.get ('/api/v1/apps/:id/download',  appsManageScope, routes.apps.downloadFile);
    router.post('/api/v1/apps/:id/upload',    appsManageScope, multipart, routes.apps.uploadFile);
    router.post('/api/v1/apps/:id/owner',     appsManageScope, routes.apps.setOwner);

    // settings routes (these are for the settings tab - avatar & name have public routes for normal users. see above)
    router.get ('/api/v1/settings/app_autoupdate_pattern', settingsScope, routes.settings.getAppAutoupdatePattern);
    router.post('/api/v1/settings/app_autoupdate_pattern', settingsScope, routes.settings.setAppAutoupdatePattern);
    router.get ('/api/v1/settings/box_autoupdate_pattern', settingsScope, routes.settings.getBoxAutoupdatePattern);
    router.post('/api/v1/settings/box_autoupdate_pattern', settingsScope, routes.settings.setBoxAutoupdatePattern);
    router.get ('/api/v1/settings/cloudron_name',      settingsScope, routes.settings.getCloudronName);
    router.post('/api/v1/settings/cloudron_name',      settingsScope, routes.settings.setCloudronName);
    router.get ('/api/v1/settings/cloudron_avatar',    settingsScope, routes.settings.getCloudronAvatar);
    router.post('/api/v1/settings/cloudron_avatar',    settingsScope, multipart, routes.settings.setCloudronAvatar);
    router.get ('/api/v1/settings/backup_config',      settingsScope, isUnmanaged, routes.settings.getBackupConfig);
    router.post('/api/v1/settings/backup_config',      settingsScope, isUnmanaged, routes.settings.setBackupConfig);
    router.get ('/api/v1/settings/platform_config',    settingsScope, isUnmanaged, routes.settings.getPlatformConfig);
    router.post('/api/v1/settings/platform_config',    settingsScope, isUnmanaged, routes.settings.setPlatformConfig);
    router.get ('/api/v1/settings/dynamic_dns',        settingsScope, isUnmanaged, routes.settings.getDynamicDnsConfig);
    router.post('/api/v1/settings/dynamic_dns',        settingsScope, isUnmanaged, routes.settings.setDynamicDnsConfig);

    router.get ('/api/v1/settings/time_zone',          settingsScope, routes.settings.getTimeZone);
    router.post('/api/v1/settings/time_zone',          settingsScope, routes.settings.setTimeZone);
    router.get ('/api/v1/settings/appstore_config',    appstoreScope, isUnmanaged, routes.settings.getAppstoreConfig);
    router.post('/api/v1/settings/appstore_config',    appstoreScope, isUnmanaged, routes.settings.setAppstoreConfig);

    router.post('/api/v1/settings/registry_config',    appstoreScope, routes.settings.setRegistryConfig);

    // email routes
    router.get ('/api/v1/mail/:domain',       mailScope, routes.mail.getDomain);
    router.post('/api/v1/mail',               mailScope, routes.mail.addDomain);
    router.get ('/api/v1/mail/:domain/stats', mailScope, routes.users.verifyPassword, routes.mail.getDomainStats);
    router.del ('/api/v1/mail/:domain',       mailScope, routes.users.verifyPassword, routes.mail.removeDomain);
    router.get ('/api/v1/mail/:domain/status',       mailScope, routes.mail.getStatus);
    router.post('/api/v1/mail/:domain/mail_from_validation', mailScope, routes.mail.setMailFromValidation);
    router.post('/api/v1/mail/:domain/catch_all',  mailScope, routes.mail.setCatchAllAddress);
    router.post('/api/v1/mail/:domain/relay',         mailScope, routes.mail.setMailRelay);
    router.post('/api/v1/mail/:domain/enable',        mailScope, routes.mail.setMailEnabled);
    router.post('/api/v1/mail/:domain/dns',        mailScope, routes.mail.setDnsRecords);
    router.post('/api/v1/mail/:domain/send_test_mail',  mailScope, routes.mail.sendTestMail);
    router.get ('/api/v1/mail/:domain/mailboxes',  mailScope, routes.mail.listMailboxes);
    router.get ('/api/v1/mail/:domain/mailboxes/:name',  mailScope, routes.mail.getMailbox);
    router.post('/api/v1/mail/:domain/mailboxes',  mailScope, routes.mail.addMailbox);
    router.post('/api/v1/mail/:domain/mailboxes/:name',  mailScope, routes.mail.updateMailbox);
    router.del ('/api/v1/mail/:domain/mailboxes/:name',  mailScope, routes.mail.removeMailbox);
    router.get ('/api/v1/mail/:domain/aliases', mailScope, routes.mail.listAliases);
    router.get ('/api/v1/mail/:domain/aliases/:name', mailScope, routes.mail.getAliases);
    router.put ('/api/v1/mail/:domain/aliases/:name', mailScope, routes.mail.setAliases);
    router.get ('/api/v1/mail/:domain/lists', mailScope, routes.mail.getLists);
    router.post('/api/v1/mail/:domain/lists', mailScope, routes.mail.addList);
    router.get ('/api/v1/mail/:domain/lists/:name', mailScope, routes.mail.getList);
    router.post('/api/v1/mail/:domain/lists/:name', mailScope, routes.mail.updateList);
    router.del ('/api/v1/mail/:domain/lists/:name', mailScope, routes.mail.removeList);

    // feedback
    router.post('/api/v1/feedback', cloudronScope, isUnmanaged, routes.cloudron.feedback);

    // domain routes
    router.post('/api/v1/domains', domainsManageScope, routes.domains.add);
    router.get ('/api/v1/domains', domainsReadScope, routes.domains.getAll);
    router.get ('/api/v1/domains/:domain', domainsManageScope, verifyDomainLock, routes.domains.get);  // this is manage scope because it returns non-restricted fields
    router.put ('/api/v1/domains/:domain', domainsManageScope, verifyDomainLock, routes.domains.update);
    router.del ('/api/v1/domains/:domain', domainsManageScope, verifyDomainLock, routes.users.verifyPassword, routes.domains.del);

    // addon routes
    router.get ('/api/v1/services', cloudronScope, routes.services.getAll);
    router.get ('/api/v1/services/:service', cloudronScope, routes.services.get);
    router.post('/api/v1/services/:service', cloudronScope, routes.services.configure);
    router.get ('/api/v1/services/:service/logs', cloudronScope, routes.services.getLogs);
    router.get ('/api/v1/services/:service/logstream', cloudronScope, routes.services.getLogStream);
    router.post('/api/v1/services/:service/restart', cloudronScope, routes.services.restart);

    // disable server socket "idle" timeout. we use the timeout middleware to handle timeouts on a route level
    // we rely on nginx for timeouts on the TCP level (see client_header_timeout)
    httpServer.setTimeout(0);

    // upgrade handler
    httpServer.on('upgrade', function (req, socket, head) {
        // create a node response object for express
        var res = new http.ServerResponse({});
        res.assignSocket(socket);

        if (req.headers.upgrade === 'websocket') {
            res.handleUpgrade = function (callback) {
                wsServer.handleUpgrade(req, socket, head, callback);
            };
        } else {
            res.sendUpgradeHandshake = function () { // could extend express.response as well
                socket.write('HTTP/1.1 101 TCP Handshake\r\n' +
                             'Upgrade: tcp\r\n' +
                             'Connection: Upgrade\r\n' +
                             '\r\n');
            };
        }

        // route through express middleware. if we provide no callback, express will provide a 'finalhandler'
        // TODO: it's not clear if socket needs to be destroyed
        app(req, res);
    });

    return httpServer;
}

// provides local webhooks for sysadmins
function initializeSysadminExpressSync() {
    var app = express();
    var httpServer = http.createServer(app);

    var QUERY_LIMIT = '1mb'; // max size for json and urlencoded queries
    var REQUEST_TIMEOUT = 10000; // timeout for all requests

    var json = middleware.json({ strict: true, limit: QUERY_LIMIT }), // application/json
        urlencoded = middleware.urlencoded({ extended: false, limit: QUERY_LIMIT }); // application/x-www-form-urlencoded

    if (process.env.BOX_ENV !== 'test') app.use(middleware.morgan('Box Sysadmin :method :url :status :response-time ms - :res[content-length]', { immediate: false }));

    var router = new express.Router();
    router.del = router.delete; // amend router.del for readability further on

    app
        .use(middleware.timeout(REQUEST_TIMEOUT))
        .use(json)
        .use(urlencoded)
        .use(router)
        .use(middleware.lastMile());

    // Sysadmin routes
    router.post('/api/v1/backup', routes.sysadmin.backup);
    router.post('/api/v1/update', routes.sysadmin.update);
    router.post('/api/v1/retire', routes.sysadmin.retire);
    router.post('/api/v1/apps/:id/import', routes.sysadmin.importAppDatabase);

    return httpServer;
}

function start(callback) {
    assert.strictEqual(typeof callback, 'function');
    assert.strictEqual(gHttpServer, null, 'Server is already up and running.');

    routes.oauth2.initialize(); // init's the oauth server

    gHttpServer = initializeExpressSync();
    gSysadminHttpServer = initializeSysadminExpressSync();

    async.series([
        routes.accesscontrol.initialize,  // hooks up authentication strategies into passport
        database.initialize,
        cloudron.initialize,
        gHttpServer.listen.bind(gHttpServer, config.get('port'), '127.0.0.1'),
        gSysadminHttpServer.listen.bind(gSysadminHttpServer, config.get('sysadminPort'), '127.0.0.1'),
        eventlog.add.bind(null, eventlog.ACTION_START, { userId: null, username: 'boot' }, { version: config.version() })
    ], callback);
}

function stop(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (!gHttpServer) return callback(null);

    async.series([
        cloudron.uninitialize,
        database.uninitialize,
        routes.accesscontrol.uninitialize,
        gHttpServer.close.bind(gHttpServer),
        gSysadminHttpServer.close.bind(gSysadminHttpServer)
    ], function (error) {
        if (error) return callback(error);

        routes.oauth2.uninitialize();

        gHttpServer = null;
        gSysadminHttpServer = null;

        callback(null);
    });
}
