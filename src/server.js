'use strict';

exports = module.exports = {
    start: start,
    stop: stop
};

var assert = require('assert'),
    async = require('async'),
    auth = require('./auth.js'),
    clients = require('./clients.js'),
    cloudron = require('./cloudron.js'),
    config = require('./config.js'),
    database = require('./database.js'),
    eventlog = require('./eventlog.js'),
    express = require('express'),
    hat = require('hat'),
    http = require('http'),
    middleware = require('./middleware'),
    passport = require('passport'),
    path = require('path'),
    routes = require('./routes/index.js'),
    setup = require('./setup.js'),
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
    var cloudronScope = routes.oauth2.scope(clients.SCOPE_CLOUDRON);
    var profileScope = routes.oauth2.scope(clients.SCOPE_PROFILE);
    var usersScope = routes.oauth2.scope(clients.SCOPE_USERS);
    var appsScope = routes.oauth2.scope(clients.SCOPE_APPS);
    var settingsScope = routes.oauth2.scope(clients.SCOPE_SETTINGS);

    // csrf protection
    var csrf = routes.oauth2.csrf;

    // public routes
    router.post('/api/v1/cloudron/dns_setup', routes.setup.providerTokenAuth, routes.setup.dnsSetup);    // only available until no-domain
    router.post('/api/v1/cloudron/restore', routes.setup.restore);    // only available until activated
    router.post('/api/v1/cloudron/activate', routes.setup.setupTokenAuth, routes.setup.activate);
    router.get ('/api/v1/cloudron/status', routes.setup.getStatus);

    router.get ('/api/v1/cloudron/progress', routes.cloudron.getProgress);
    router.get ('/api/v1/cloudron/avatar', routes.settings.getCloudronAvatar); // this is a public alias for /api/v1/settings/cloudron_avatar

    // developer routes
    router.post('/api/v1/developer/login', routes.developer.login);

    // cloudron routes
    router.get ('/api/v1/cloudron/config', cloudronScope, routes.cloudron.getConfig);
    router.post('/api/v1/cloudron/update', cloudronScope, routes.user.requireAdmin, routes.cloudron.update);
    router.post('/api/v1/cloudron/check_for_updates', cloudronScope, routes.user.requireAdmin, routes.cloudron.checkForUpdates);
    router.post('/api/v1/cloudron/reboot', cloudronScope, routes.user.requireAdmin, routes.cloudron.reboot);
    router.get ('/api/v1/cloudron/graphs', cloudronScope, routes.user.requireAdmin, routes.graphs.getGraphs);
    router.get ('/api/v1/cloudron/disks', cloudronScope, routes.user.requireAdmin, routes.cloudron.getDisks);
    router.get ('/api/v1/cloudron/logs', cloudronScope, routes.user.requireAdmin, routes.cloudron.getLogs);
    router.get ('/api/v1/cloudron/logstream', cloudronScope, routes.user.requireAdmin, routes.cloudron.getLogStream);
    router.get ('/api/v1/cloudron/ssh/authorized_keys', cloudronScope, routes.user.requireAdmin, routes.ssh.getAuthorizedKeys);
    router.put ('/api/v1/cloudron/ssh/authorized_keys', cloudronScope, routes.user.requireAdmin, routes.ssh.addAuthorizedKey);
    router.get ('/api/v1/cloudron/ssh/authorized_keys/:identifier', cloudronScope, routes.user.requireAdmin, routes.ssh.getAuthorizedKey);
    router.del ('/api/v1/cloudron/ssh/authorized_keys/:identifier', cloudronScope, routes.user.requireAdmin, routes.ssh.delAuthorizedKey);
    router.get ('/api/v1/cloudron/eventlog', cloudronScope, routes.user.requireAdmin, routes.eventlog.get);

    // working off the user behind the provided token
    router.get ('/api/v1/user/profile', profileScope, routes.profile.get);
    router.post('/api/v1/user/profile', profileScope, routes.profile.update);
    router.post('/api/v1/user/profile/password', profileScope, routes.user.verifyPassword, routes.profile.changePassword);
    router.post('/api/v1/user/profile/twofactorauthentication', profileScope, routes.profile.setTwoFactorAuthenticationSecret);
    router.post('/api/v1/user/profile/twofactorauthentication/enable', profileScope, routes.profile.enableTwoFactorAuthentication);
    router.post('/api/v1/user/profile/twofactorauthentication/disable', profileScope, routes.user.verifyPassword, routes.profile.disableTwoFactorAuthentication);

    // user routes
    router.get ('/api/v1/users', usersScope, routes.user.requireAdmin, routes.user.list);
    router.post('/api/v1/users', usersScope, routes.user.requireAdmin, routes.user.create);
    router.get ('/api/v1/users/:userId', usersScope, routes.user.requireAdmin, routes.user.get);
    router.del ('/api/v1/users/:userId', usersScope, routes.user.requireAdmin, routes.user.verifyPassword, routes.user.remove);
    router.post('/api/v1/users/:userId', usersScope, routes.user.requireAdmin, routes.user.update);
    router.put ('/api/v1/users/:userId/groups', usersScope, routes.user.requireAdmin, routes.user.setGroups);
    router.post('/api/v1/users/:userId/invite', usersScope, routes.user.requireAdmin, routes.user.sendInvite);

    // Group management
    router.get ('/api/v1/groups', usersScope, routes.user.requireAdmin, routes.groups.list);
    router.post('/api/v1/groups', usersScope, routes.user.requireAdmin, routes.groups.create);
    router.get ('/api/v1/groups/:groupId', usersScope, routes.user.requireAdmin, routes.groups.get);
    router.put ('/api/v1/groups/:groupId/members', usersScope, routes.user.requireAdmin, routes.groups.updateMembers);
    router.del ('/api/v1/groups/:groupId', usersScope, routes.user.requireAdmin, routes.user.verifyPassword, routes.groups.remove);

    // form based login routes used by oauth2 frame
    router.get ('/api/v1/session/login', csrf, routes.oauth2.loginForm);
    router.post('/api/v1/session/login', csrf, routes.oauth2.login);
    router.get ('/api/v1/session/logout', routes.oauth2.logout);
    router.get ('/api/v1/session/callback', routes.oauth2.callback);
    router.get ('/api/v1/session/password/resetRequest.html', csrf, routes.oauth2.passwordResetRequestSite);
    router.post('/api/v1/session/password/resetRequest', csrf, routes.oauth2.passwordResetRequest);
    router.get ('/api/v1/session/password/sent.html', routes.oauth2.passwordSentSite);
    router.get ('/api/v1/session/password/reset.html', csrf, routes.oauth2.passwordResetSite);
    router.post('/api/v1/session/password/reset', csrf, routes.oauth2.passwordReset);
    router.get ('/api/v1/session/account/setup.html', csrf, routes.oauth2.accountSetupSite);
    router.post('/api/v1/session/account/setup', csrf, routes.oauth2.accountSetup);

    // oauth2 routes
    router.get ('/api/v1/oauth/dialog/authorize', routes.oauth2.authorization);
    router.post('/api/v1/oauth/token', routes.oauth2.token);
    router.get ('/api/v1/oauth/clients', settingsScope, routes.clients.getAll);
    router.post('/api/v1/oauth/clients', settingsScope, routes.clients.add);
    router.get ('/api/v1/oauth/clients/:clientId', settingsScope, routes.clients.get);
    router.post('/api/v1/oauth/clients/:clientId', settingsScope, routes.clients.add);
    router.del ('/api/v1/oauth/clients/:clientId', settingsScope, routes.clients.del);
    router.get ('/api/v1/oauth/clients/:clientId/tokens', settingsScope, routes.clients.getClientTokens);
    router.post('/api/v1/oauth/clients/:clientId/tokens', settingsScope, routes.clients.addClientToken);
    router.del ('/api/v1/oauth/clients/:clientId/tokens', settingsScope, routes.clients.delClientTokens);
    router.del ('/api/v1/oauth/clients/:clientId/tokens/:tokenId', settingsScope, routes.clients.delToken);

    // app routes
    router.get ('/api/v1/apps',          appsScope, routes.apps.getApps);
    router.get ('/api/v1/apps/:id',      appsScope, routes.apps.getApp);
    router.get ('/api/v1/apps/:id/icon', routes.apps.getAppIcon);

    router.post('/api/v1/apps/install',       appsScope, routes.user.requireAdmin, routes.apps.installApp);
    router.post('/api/v1/apps/:id/uninstall', appsScope, routes.user.requireAdmin, routes.user.verifyPassword, routes.apps.uninstallApp);
    router.post('/api/v1/apps/:id/configure', appsScope, routes.user.requireAdmin, routes.apps.configureApp);
    router.post('/api/v1/apps/:id/update',    appsScope, routes.user.requireAdmin, routes.apps.updateApp);
    router.post('/api/v1/apps/:id/restore',   appsScope, routes.user.requireAdmin, routes.user.verifyPassword, routes.apps.restoreApp);
    router.post('/api/v1/apps/:id/backup',    appsScope, routes.user.requireAdmin, routes.apps.backupApp);
    router.get ('/api/v1/apps/:id/backups',   appsScope, routes.user.requireAdmin, routes.apps.listBackups);
    router.post('/api/v1/apps/:id/stop',      appsScope, routes.user.requireAdmin, routes.apps.stopApp);
    router.post('/api/v1/apps/:id/start',     appsScope, routes.user.requireAdmin, routes.apps.startApp);
    router.get ('/api/v1/apps/:id/logstream', appsScope, routes.user.requireAdmin, routes.apps.getLogStream);
    router.get ('/api/v1/apps/:id/logs',      appsScope, routes.user.requireAdmin, routes.apps.getLogs);
    router.get ('/api/v1/apps/:id/exec',      appsScope, routes.user.requireAdmin, routes.apps.exec);
    // websocket cannot do bearer authentication
    router.get ('/api/v1/apps/:id/execws',    routes.oauth2.websocketAuth.bind(null, [ clients.SCOPE_APPS ]), routes.user.requireAdmin, routes.apps.execWebSocket);
    router.post('/api/v1/apps/:id/clone',     appsScope, routes.user.requireAdmin, routes.apps.cloneApp);
    router.get ('/api/v1/apps/:id/download',  appsScope, routes.user.requireAdmin, routes.apps.downloadFile);
    router.post('/api/v1/apps/:id/upload',    appsScope, routes.user.requireAdmin, multipart, routes.apps.uploadFile);

    // settings routes (these are for the settings tab - avatar & name have public routes for normal users. see above)
    router.get ('/api/v1/settings/app_autoupdate_pattern', settingsScope, routes.user.requireAdmin, routes.settings.getAppAutoupdatePattern);
    router.post('/api/v1/settings/app_autoupdate_pattern', settingsScope, routes.user.requireAdmin, routes.settings.setAppAutoupdatePattern);
    router.get ('/api/v1/settings/box_autoupdate_pattern', settingsScope, routes.user.requireAdmin, routes.settings.getBoxAutoupdatePattern);
    router.post('/api/v1/settings/box_autoupdate_pattern', settingsScope, routes.user.requireAdmin, routes.settings.setBoxAutoupdatePattern);
    router.get ('/api/v1/settings/cloudron_name',      settingsScope, routes.user.requireAdmin, routes.settings.getCloudronName);
    router.post('/api/v1/settings/cloudron_name',      settingsScope, routes.user.requireAdmin, routes.settings.setCloudronName);
    router.get ('/api/v1/settings/cloudron_avatar',    settingsScope, routes.user.requireAdmin, routes.settings.getCloudronAvatar);
    router.post('/api/v1/settings/cloudron_avatar',    settingsScope, routes.user.requireAdmin, multipart, routes.settings.setCloudronAvatar);
    router.get ('/api/v1/settings/backup_config',      settingsScope, routes.user.requireAdmin, routes.settings.getBackupConfig);
    router.post('/api/v1/settings/backup_config',      settingsScope, routes.user.requireAdmin, routes.settings.setBackupConfig);

    router.get ('/api/v1/settings/time_zone',          settingsScope, routes.user.requireAdmin, routes.settings.getTimeZone);
    router.post('/api/v1/settings/time_zone',          settingsScope, routes.user.requireAdmin, routes.settings.setTimeZone);
    router.get ('/api/v1/settings/appstore_config',    settingsScope, routes.user.requireAdmin, routes.settings.getAppstoreConfig);
    router.post('/api/v1/settings/appstore_config',    settingsScope, routes.user.requireAdmin, routes.settings.setAppstoreConfig);

    // email routes
    router.get ('/api/v1/mail/:domain',       settingsScope, routes.user.requireAdmin, routes.mail.getDomain);
    router.post('/api/v1/mail/:domain',       settingsScope, routes.user.requireAdmin, routes.mail.updateDomain);
    router.post('/api/v1/mail',               settingsScope, routes.user.requireAdmin, routes.mail.addDomain);
    router.get ('/api/v1/mail/:domain/stats', settingsScope, routes.user.requireAdmin, routes.user.verifyPassword, routes.mail.getDomainStats);
    router.del ('/api/v1/mail/:domain',       settingsScope, routes.user.requireAdmin, routes.user.verifyPassword, routes.mail.removeDomain);
    router.get ('/api/v1/mail/:domain/status',       settingsScope, routes.user.requireAdmin, routes.mail.getStatus);
    router.post('/api/v1/mail/:domain/mail_from_validation', settingsScope, routes.user.requireAdmin, routes.mail.setMailFromValidation);
    router.post('/api/v1/mail/:domain/catch_all',  settingsScope, routes.user.requireAdmin, routes.mail.setCatchAllAddress);
    router.post('/api/v1/mail/:domain/relay',         settingsScope, routes.user.requireAdmin, routes.mail.setMailRelay);
    router.post('/api/v1/mail/:domain/enable',        settingsScope, routes.user.requireAdmin, routes.mail.setMailEnabled);
    router.post('/api/v1/mail/:domain/send_test_mail',  settingsScope, routes.user.requireAdmin, routes.mail.sendTestMail);
    router.get ('/api/v1/mail/:domain/mailboxes',  settingsScope, routes.user.requireAdmin, routes.mail.getMailboxes);
    router.get ('/api/v1/mail/:domain/mailboxes/:name',  settingsScope, routes.user.requireAdmin, routes.mail.getMailbox);
    router.post('/api/v1/mail/:domain/mailboxes',  settingsScope, routes.user.requireAdmin, routes.mail.addMailbox);
    router.post('/api/v1/mail/:domain/mailboxes/:name',  settingsScope, routes.user.requireAdmin, routes.mail.updateMailbox);
    router.del ('/api/v1/mail/:domain/mailboxes/:name',  settingsScope, routes.user.requireAdmin, routes.mail.removeMailbox);
    router.get ('/api/v1/mail/:domain/aliases', settingsScope, routes.user.requireAdmin, routes.mail.listAliases);
    router.get ('/api/v1/mail/:domain/aliases/:name', settingsScope, routes.user.requireAdmin, routes.mail.getAliases);
    router.put ('/api/v1/mail/:domain/aliases/:name', settingsScope, routes.user.requireAdmin, routes.mail.setAliases);
    router.get ('/api/v1/mail/:domain/lists', settingsScope, routes.user.requireAdmin, routes.mail.getLists);
    router.post('/api/v1/mail/:domain/lists', settingsScope, routes.user.requireAdmin, routes.mail.addList);
    router.get ('/api/v1/mail/:domain/lists/:name', settingsScope, routes.user.requireAdmin, routes.mail.getList);
    router.post('/api/v1/mail/:domain/lists/:name', settingsScope, routes.user.requireAdmin, routes.mail.updateList);
    router.del ('/api/v1/mail/:domain/lists/:name', settingsScope, routes.user.requireAdmin, routes.mail.removeList);

    // feedback
    router.post('/api/v1/feedback', usersScope, routes.cloudron.feedback);

    // backup routes
    router.get ('/api/v1/backups', settingsScope, routes.user.requireAdmin, routes.backups.get);
    router.post('/api/v1/backups', settingsScope, routes.user.requireAdmin, routes.backups.create);

    // domain routes
    router.post('/api/v1/domains', settingsScope, routes.user.requireAdmin, routes.domains.add);
    router.get ('/api/v1/domains', settingsScope, routes.user.requireAdmin, routes.domains.getAll);
    router.get ('/api/v1/domains/:domain', settingsScope, routes.user.requireAdmin, routes.domains.get);
    router.put ('/api/v1/domains/:domain', settingsScope, routes.user.requireAdmin, routes.domains.update);
    router.del ('/api/v1/domains/:domain', settingsScope, routes.user.requireAdmin, routes.user.verifyPassword, routes.domains.del);

    // caas routes
    router.post('/api/v1/caas/change_plan', cloudronScope, routes.user.requireAdmin, routes.user.verifyPassword, routes.caas.changePlan);

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

    return httpServer;
}

function start(callback) {
    assert.strictEqual(typeof callback, 'function');
    assert.strictEqual(gHttpServer, null, 'Server is already up and running.');

    gHttpServer = initializeExpressSync();
    gSysadminHttpServer = initializeSysadminExpressSync();

    async.series([
        auth.initialize,
        database.initialize,
        cloudron.initialize,
        setup.configureWebadmin,
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
        auth.uninitialize,
        gHttpServer.close.bind(gHttpServer),
        gSysadminHttpServer.close.bind(gSysadminHttpServer)
    ], function (error) {
        if (error) console.error(error);

        gHttpServer = null;
        gSysadminHttpServer = null;

        callback(null);
    });
}
