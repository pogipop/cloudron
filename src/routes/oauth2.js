'use strict';

exports = module.exports = {
    initialize: initialize,
    uninitialize: uninitialize,
    loginForm: loginForm,
    login: login,
    logout: logout,
    sessionCallback: sessionCallback,
    passwordResetRequestSite: passwordResetRequestSite,
    passwordResetRequest: passwordResetRequest,
    passwordSentSite: passwordSentSite,
    passwordResetSite: passwordResetSite,
    passwordReset: passwordReset,
    accountSetupSite: accountSetupSite,
    accountSetup: accountSetup,
    authorization: authorization,
    token: token,
    csrf: csrf
};

var accesscontrol = require('../accesscontrol.js'),
    apps = require('../apps.js'),
    assert = require('assert'),
    authcodedb = require('../authcodedb.js'),
    clients = require('../clients'),
    ClientsError = clients.ClientsError,
    config = require('../config.js'),
    constants = require('../constants.js'),
    DatabaseError = require('../databaseerror.js'),
    debug = require('debug')('box:routes/oauth2'),
    eventlog = require('../eventlog.js'),
    hat = require('../hat.js'),
    HttpError = require('connect-lastmile').HttpError,
    middleware = require('../middleware/index.js'),
    oauth2orize = require('oauth2orize'),
    passport = require('passport'),
    querystring = require('querystring'),
    session = require('connect-ensure-login'),
    settings = require('../settings.js'),
    speakeasy = require('speakeasy'),
    tokendb = require('../tokendb.js'),
    url = require('url'),
    users = require('../users.js'),
    UsersError = users.UsersError,
    util = require('util'),
    _ = require('underscore');

// appObject is optional here
function auditSource(req, appId, appObject) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { authType: 'oauth', ip: ip, appId: appId, app: appObject };
}

// create OAuth 2.0 server
var gServer = null;

function initialize() {
    assert(gServer === null);

    gServer = oauth2orize.createServer();

    // Register serialialization and deserialization functions.
    //
    // The client id is stored in the session and can thus be retrieved for each
    // step in the oauth flow transaction, which involves multiple http requests.

    gServer.serializeClient(function (client, callback) {
        return callback(null, client.id);
    });

    gServer.deserializeClient(function (id, callback) {
        clients.get(id, callback);
    });


    // Register supported grant types.

    // Grant authorization codes.  The callback takes the `client` requesting
    // authorization, the `redirectURI` (which is used as a verifier in the
    // subsequent exchange), the authenticated `user` granting access, and
    // their response, which contains approved scope, duration, etc. as parsed by
    // the application.  The application issues a code, which is bound to these
    // values, and will be exchanged for an access token.

    gServer.grant(oauth2orize.grant.code({ scopeSeparator: ',' }, function (client, redirectURI, user, ares, callback) {
        debug('grant code:', client.id, redirectURI, user.id, ares);

        var code = hat(256);
        var expiresAt = Date.now() + 60 * 60000; // 1 hour

        authcodedb.add(code, client.id, user.id, expiresAt, function (error) {
            if (error) return callback(error);

            debug('grant code: new auth code for client %s code %s', client.id, code);

            callback(null, code);
        });
    }));


    gServer.grant(oauth2orize.grant.token({ scopeSeparator: ',' }, function (client, user, ares, callback) {
        debug('grant token:', client.id, user.id, ares);

        var token = tokendb.generateToken();
        var expires = Date.now() + constants.DEFAULT_TOKEN_EXPIRATION;
        var scope = accesscontrol.intersectScope(user.scope, client.scope);

        tokendb.add(token, user.id, client.id, expires, scope, function (error) {
            if (error) return callback(error);

            debug('grant token: new access token for client %s token %s', client.id, token);

            callback(null, token);
        });
    }));


    // Exchange authorization codes for access tokens.  The callback accepts the
    // `client`, which is exchanging `code` and any `redirectURI` from the
    // authorization request for verification.  If these values are validated, the
    // application issues an access token on behalf of the user who authorized the
    // code.

    gServer.exchange(oauth2orize.exchange.code(function (client, code, redirectURI, callback) {
        debug('exchange:', client, code, redirectURI);

        authcodedb.get(code, function (error, authCode) {
            if (error && error.reason === DatabaseError.NOT_FOUND) return callback(null, false);
            if (error) return callback(error);
            if (client.id !== authCode.clientId) return callback(null, false);

            authcodedb.del(code, function (error) {
                if(error) return callback(error);

                var token = tokendb.generateToken();
                var expires = Date.now() + constants.DEFAULT_TOKEN_EXPIRATION;
                var scope = accesscontrol.canonicalScope(client.scope);

                tokendb.add(token, authCode.userId, authCode.clientId, expires, client.scope, function (error) {
                    if (error) return callback(error);

                    debug('exchange: new access token for client %s token %s', client.id, token);

                    callback(null, token);
                });
            });
        });
    }));

    // overwrite the session.ensureLoggedIn to not use res.redirect() due to a chrome bug not sending cookies on redirects
    session.ensureLoggedIn = function (redirectTo) {
        assert.strictEqual(typeof redirectTo, 'string');

        return function (req, res, next) {
            if (!req.isAuthenticated || !req.isAuthenticated()) {
                if (req.session) {
                    req.session.returnTo = req.originalUrl || req.url;
                }

                res.status(200).send(util.format('<script>window.location.href = "%s";</script>', redirectTo));
            } else {
                next();
            }
        };
    };
}

function uninitialize() {
    gServer = null;
}

function renderTemplate(res, template, data) {
    assert.strictEqual(typeof res, 'object');
    assert.strictEqual(typeof template, 'string');
    assert.strictEqual(typeof data, 'object');

    settings.getCloudronName(function (error, cloudronName) {
        if (error) {
            console.error(error);
            cloudronName = 'Cloudron';
        }

        // amend template properties, for example used in the header
        data.title = data.title || 'Cloudron';
        data.adminOrigin = config.adminOrigin();
        data.cloudronName = cloudronName;

        res.render(template, data);
    });
}

function sendErrorPageOrRedirect(req, res, message) {
    assert.strictEqual(typeof req, 'object');
    assert.strictEqual(typeof res, 'object');
    assert.strictEqual(typeof message, 'string');

    debug('sendErrorPageOrRedirect: returnTo %s.', req.query.returnTo, message);

    if (typeof req.query.returnTo !== 'string') {
        renderTemplate(res, 'error', {
            message: message,
            title: 'Cloudron Error'
        });
    } else {
        var u = url.parse(req.query.returnTo);
        if (!u.protocol || !u.host) {
            return renderTemplate(res, 'error', {
                message: 'Invalid request. returnTo query is not a valid URI. ' + message,
                title: 'Cloudron Error'
            });
        }

        res.redirect(util.format('%s//%s', u.protocol, u.host));
    }
}

// use this instead of sendErrorPageOrRedirect(), in case we have a returnTo provided in the query, to avoid login loops
// This usually happens when the OAuth client ID is wrong
function sendError(req, res, message) {
    assert.strictEqual(typeof req, 'object');
    assert.strictEqual(typeof res, 'object');
    assert.strictEqual(typeof message, 'string');

    renderTemplate(res, 'error', {
        message: message,
        title: 'Cloudron Error'
    });
}

// -> GET /api/v1/session/login
function loginForm(req, res) {
    if (typeof req.session.returnTo !== 'string') return sendErrorPageOrRedirect(req, res, 'Invalid login request. No returnTo provided.');

    var u = url.parse(req.session.returnTo, true);
    if (!u.query.client_id) return sendErrorPageOrRedirect(req, res, 'Invalid login request. No client_id provided.');

    function render(applicationName, applicationLogo) {
        var error = req.query.error || null;

        renderTemplate(res, 'login', {
            csrf: req.csrfToken(),
            applicationName: applicationName,
            applicationLogo: applicationLogo,
            error: error,
            username: config.isDemo() ? constants.DEMO_USERNAME : '',
            password: config.isDemo() ? 'cloudron' : '',
            title: applicationName + ' Login'
        });
    }

    function renderBuiltIn() {
        settings.getCloudronName(function (error, cloudronName) {
            if (error) {
                console.error(error);
                cloudronName = 'Cloudron';
            }

            render(cloudronName, '/api/v1/cloudron/avatar');
        });
    }

    clients.get(u.query.client_id, function (error, result) {
        if (error) return sendError(req, res, 'Unknown OAuth client');

        switch (result.type) {
        case clients.TYPE_BUILT_IN: return renderBuiltIn();
        case clients.TYPE_EXTERNAL: return render(result.appId, '/api/v1/cloudron/avatar');
        default: break;
        }

        apps.get(result.appId, function (error, result) {
            if (error) return sendErrorPageOrRedirect(req, res, 'Unknown Application for those OAuth credentials');

            var applicationName = result.fqdn;
            render(applicationName, '/api/v1/apps/' + result.id + '/icon');
        });
    });
}

// -> POST /api/v1/session/login
function login(req, res) {
    var returnTo = req.session.returnTo || req.query.returnTo;

    var failureQuery = querystring.stringify({ error: 'Invalid username or password', returnTo: returnTo });
    passport.authenticate('local', {
        failureRedirect: '/api/v1/session/login?' + failureQuery
    })(req, res, function () {
        if (!req.user.ghost && req.user.twoFactorAuthenticationEnabled) {
            if (!req.body.totpToken) {
                let failureQuery = querystring.stringify({ error: 'A 2FA token is required', returnTo: returnTo });
                return res.redirect('/api/v1/session/login?' + failureQuery);
            }

            let verified = speakeasy.totp.verify({ secret: req.user.twoFactorAuthenticationSecret, encoding: 'base32', token: req.body.totpToken });
            if (!verified) {
                let failureQuery = querystring.stringify({ error: 'The 2FA token is invalid', returnTo: returnTo });
                return res.redirect('/api/v1/session/login?' + failureQuery);
            }
        }

        res.redirect(returnTo);
    });
}

// -> GET /api/v1/session/logout
function logout(req, res) {
    req.logout();

    if (req.query && req.query.redirect) res.redirect(req.query.redirect);
    else res.redirect('/');
}

// Form to enter email address to send a password reset request mail
// -> GET /api/v1/session/password/resetRequest.html
function passwordResetRequestSite(req, res) {
    var data = {
        csrf: req.csrfToken(),
        title: 'Password Reset'
    };

    renderTemplate(res, 'password_reset_request', data);
}

// This route is used for above form submission
// -> POST /api/v1/session/password/resetRequest
function passwordResetRequest(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.identifier !== 'string') return next(new HttpError(400, 'Missing identifier')); // email or username

    debug('passwordResetRequest: email or username %s.', req.body.identifier);

    users.resetPasswordByIdentifier(req.body.identifier, function (error) {
        if (error && error.reason !== UsersError.NOT_FOUND) {
            console.error(error);
            return sendErrorPageOrRedirect(req, res, 'User not found');
        }

        res.redirect('/api/v1/session/password/sent.html');
    });
}

// -> GET /api/v1/session/password/sent.html
function passwordSentSite(req, res) {
    renderTemplate(res, 'password_reset_sent', { title: 'Cloudron Password Reset' });
}

function renderAccountSetupSite(res, req, userObject, error) {
    renderTemplate(res, 'account_setup', {
        user: userObject,
        error: error,
        csrf: req.csrfToken(),
        resetToken: req.query.reset_token || req.body.resetToken,
        email: req.query.email || req.body.email,
        title: 'Password Setup'
    });
}

// -> GET /api/v1/session/account/setup.html
function accountSetupSite(req, res) {
    if (!req.query.reset_token) return sendError(req, res, 'Missing Reset Token');
    if (!req.query.email) return sendError(req, res, 'Missing Email');

    users.getByResetToken(req.query.email, req.query.reset_token, function (error, userObject) {
        if (error) return sendError(req, res, 'Invalid Email or Reset Token');

        renderAccountSetupSite(res, req, userObject, '');
    });
}

// -> POST /api/v1/session/account/setup
function accountSetup(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.email !== 'string') return next(new HttpError(400, 'Missing email'));
    if (typeof req.body.resetToken !== 'string') return next(new HttpError(400, 'Missing resetToken'));
    if (typeof req.body.password !== 'string') return next(new HttpError(400, 'Missing password'));
    if (typeof req.body.username !== 'string') return next(new HttpError(400, 'Missing username'));
    if (typeof req.body.displayName !== 'string') return next(new HttpError(400, 'Missing displayName'));

    debug(`acountSetup: for email ${req.body.email} with token ${req.body.resetToken}`);

    users.getByResetToken(req.body.email, req.body.resetToken, function (error, userObject) {
        if (error) return sendError(req, res, 'Invalid Reset Token');

        var data = _.pick(req.body, 'username', 'displayName');
        users.update(userObject.id, data, auditSource(req), function (error) {
            if (error && error.reason === UsersError.ALREADY_EXISTS) return renderAccountSetupSite(res, req, userObject, 'Username already exists');
            if (error && error.reason === UsersError.BAD_FIELD) return renderAccountSetupSite(res, req, userObject, error.message);
            if (error && error.reason === UsersError.NOT_FOUND) return renderAccountSetupSite(res, req, userObject, 'No such user');
            if (error) return next(new HttpError(500, error));

            userObject.username = req.body.username;
            userObject.displayName = req.body.displayName;

            // setPassword clears the resetToken
            users.setPassword(userObject.id, req.body.password, function (error, result) {
                if (error && error.reason === UsersError.BAD_FIELD) return renderAccountSetupSite(res, req, userObject, error.message);

                if (error) return next(new HttpError(500, error));

                res.redirect(config.adminOrigin());
            });
        });
    });
}

// -> GET /api/v1/session/password/reset.html
function passwordResetSite(req, res, next) {
    if (!req.query.email) return next(new HttpError(400, 'Missing email'));
    if (!req.query.reset_token) return next(new HttpError(400, 'Missing reset_token'));

    users.getByResetToken(req.query.email, req.query.reset_token, function (error, user) {
        if (error) return next(new HttpError(401, 'Invalid email or reset token'));

        renderTemplate(res, 'password_reset', {
            user: user,
            csrf: req.csrfToken(),
            resetToken: req.query.reset_token,
            email: req.query.email,
            title: 'Password Reset'
        });
    });
}

// -> POST /api/v1/session/password/reset
function passwordReset(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.email !== 'string') return next(new HttpError(400, 'Missing email'));
    if (typeof req.body.resetToken !== 'string') return next(new HttpError(400, 'Missing resetToken'));
    if (typeof req.body.password !== 'string') return next(new HttpError(400, 'Missing password'));

    debug(`passwordReset: for ${req.body.email} with token ${req.body.resetToken}`);

    users.getByResetToken(req.body.email, req.body.resetToken, function (error, userObject) {
        if (error) return next(new HttpError(401, 'Invalid email or resetToken'));

        if (!userObject.username) return next(new HttpError(401, 'No username set'));

        // setPassword clears the resetToken
        users.setPassword(userObject.id, req.body.password, function (error) {
            if (error && error.reason === UsersError.BAD_FIELD) return next(new HttpError(406, error.message));
            if (error) return next(new HttpError(500, error));

            res.redirect(config.adminOrigin());
        });
    });
}


// The callback page takes the redirectURI and the authCode and redirects the browser accordingly
//
// -> GET /api/v1/session/callback
function sessionCallback() {
    return [
        session.ensureLoggedIn('/api/v1/session/login'),
        function (req, res) {
            renderTemplate(res, 'callback', { callbackServer: req.query.redirectURI });
        }
    ];
}

// The authorization endpoint is the entry point for an OAuth login.
//
// Each app would start OAuth by redirecting the user to:
//
//    /api/v1/oauth/dialog/authorize?response_type=code&client_id=<clientId>&redirect_uri=<callbackURL>&scope=<ignored>
//
//  - First, this will ensure the user is logged in.
//  - Then it will redirect the browser to the given <callbackURL> containing the authcode in the query
//
// -> GET /api/v1/oauth/dialog/authorize
function authorization() {
    return [
        function (req, res, next) {
            if (!req.query.redirect_uri) return sendErrorPageOrRedirect(req, res, 'Invalid request. redirect_uri query param is not set.');
            if (!req.query.client_id) return sendErrorPageOrRedirect(req, res, 'Invalid request. client_id query param is not set.');
            if (!req.query.response_type) return sendErrorPageOrRedirect(req, res, 'Invalid request. response_type query param is not set.');
            if (req.query.response_type !== 'code' && req.query.response_type !== 'token') return sendErrorPageOrRedirect(req, res, 'Invalid request. Only token and code response types are supported.');

            session.ensureLoggedIn('/api/v1/session/login?returnTo=' + req.query.redirect_uri)(req, res, next);
        },
        gServer.authorization({}, function (clientId, redirectURI, callback) {
            debug('authorization: client %s with callback to %s.', clientId, redirectURI);

            clients.get(clientId, function (error, client) {
                if (error && error.reason === ClientsError.NOT_FOUND) return callback(null, false);
                if (error) return callback(error);

                // ignore the origin passed into form the client, but use the one from the clientdb
                var redirectPath = url.parse(redirectURI).path;
                var redirectOrigin = client.redirectURI;

                callback(null, client, '/api/v1/session/callback?redirectURI=' + encodeURIComponent(url.resolve(redirectOrigin, redirectPath)));
            });
        }),
        function (req, res, next) {
            // Handle our different types of oauth clients
            var type = req.oauth2.client.type;

            if (type === clients.TYPE_EXTERNAL || type === clients.TYPE_BUILT_IN) {
                eventlog.add(eventlog.ACTION_USER_LOGIN, auditSource(req, req.oauth2.client.appId), { userId: req.oauth2.user.id, user: users.removePrivateFields(req.oauth2.user) });
                return next();
            }

            apps.get(req.oauth2.client.appId, function (error, appObject) {
                if (error) return sendErrorPageOrRedirect(req, res, 'Invalid request. Unknown app for this client_id.');

                apps.hasAccessTo(appObject, req.oauth2.user, function (error, access) {
                    if (error) return sendError(req, res, 'Internal error');
                    if (!access) return sendErrorPageOrRedirect(req, res, 'No access to this app.');

                    eventlog.add(eventlog.ACTION_USER_LOGIN, auditSource(req, appObject.id, appObject), { userId: req.oauth2.user.id, user: users.removePrivateFields(req.oauth2.user) });

                    next();
                });
            });
        },
        gServer.decision({ loadTransaction: false })
    ];
}

//  The token endpoint allows an OAuth client to exchange an authcode with an accesstoken.
//
//  Authcodes are obtained using the authorization endpoint. The route is authenticated by
//  providing a Basic auth with clientID as username and clientSecret as password.
//  An authcode is only good for one such exchange to an accesstoken.
//
// -> POST /api/v1/oauth/token
function token() {
    return [
        passport.authenticate(['basic', 'oauth2-client-password'], { session: false }),
        gServer.token(),
        gServer.errorHandler()
    ];
}

// Cross-site request forgery protection middleware for login form
function csrf() {
    return [
        middleware.csrf(),
        function (err, req, res, next) {
            if (err.code !== 'EBADCSRFTOKEN') return next(err);

            sendErrorPageOrRedirect(req, res, 'Form expired');
        }
    ];
}
