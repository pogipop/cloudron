'use strict';

var apps = require('../apps'),
    assert = require('assert'),
    auth = require('../auth.js'),
    authcodedb = require('../authcodedb'),
    clients = require('../clients'),
    ClientsError = clients.ClientsError,
    config = require('../config.js'),
    constants = require('../constants'),
    DatabaseError = require('../databaseerror'),
    debug = require('debug')('box:routes/oauth2'),
    eventlog = require('../eventlog.js'),
    hat = require('hat'),
    HttpError = require('connect-lastmile').HttpError,
    middleware = require('../middleware/index.js'),
    oauth2orize = require('oauth2orize'),
    passport = require('passport'),
    querystring = require('querystring'),
    session = require('connect-ensure-login'),
    settings = require('../settings'),
    tokendb = require('../tokendb'),
    url = require('url'),
    user = require('../user.js'),
    UserError = user.UserError,
    util = require('util'),
    _ = require('underscore');

// appObject is optional here
function auditSource(req, appId, appObject) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { authType: 'oauth', ip: ip, appId: appId, app: appObject };
}

// create OAuth 2.0 server
var gServer = oauth2orize.createServer();

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

    tokendb.add(token, user.id, client.id, expires, client.scope, function (error) {
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

    if (typeof req.body.identifier !== 'string') return next(new HttpError(400, 'Missing identifier'));

    debug('passwordResetRequest: email or username %s.', req.body.identifier);

    user.resetPasswordByIdentifier(req.body.identifier, function (error) {
        if (error && error.reason !== UserError.NOT_FOUND) {
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
        title: 'Password Setup'
    });
}

// -> GET /api/v1/session/account/setup.html
function accountSetupSite(req, res) {
    if (!req.query.reset_token) return sendError(req, res, 'Missing Reset Token');

    user.getByResetToken(req.query.reset_token, function (error, userObject) {
        if (error) return sendError(req, res, 'Invalid Reset Token');

        renderAccountSetupSite(res, req, userObject, '');
    });
}

// -> POST /api/v1/session/account/setup
function accountSetup(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.resetToken !== 'string') return next(new HttpError(400, 'Missing resetToken'));
    if (typeof req.body.password !== 'string') return next(new HttpError(400, 'Missing password'));
    if (typeof req.body.username !== 'string') return next(new HttpError(400, 'Missing username'));
    if (typeof req.body.displayName !== 'string') return next(new HttpError(400, 'Missing displayName'));

    debug('acountSetup: with token %s.', req.body.resetToken);

    user.getByResetToken(req.body.resetToken, function (error, userObject) {
        if (error) return sendError(req, res, 'Invalid Reset Token');

        var data = _.pick(req.body, 'username', 'displayName');
        user.update(userObject.id, data, auditSource(req), function (error) {
            if (error && error.reason === UserError.ALREADY_EXISTS) return renderAccountSetupSite(res, req, userObject, 'Username already exists');
            if (error && error.reason === UserError.BAD_FIELD) return renderAccountSetupSite(res, req, userObject, error.message);
            if (error && error.reason === UserError.NOT_FOUND) return renderAccountSetupSite(res, req, userObject, 'No such user');
            if (error) return next(new HttpError(500, error));

            userObject.username = req.body.username;
            userObject.displayName = req.body.displayName;

            // setPassword clears the resetToken
            user.setPassword(userObject.id, req.body.password, function (error, result) {
                if (error && error.reason === UserError.BAD_FIELD) return renderAccountSetupSite(res, req, userObject, error.message);

                if (error) return next(new HttpError(500, error));

                res.redirect(util.format('%s?accessToken=%s&expiresAt=%s', config.adminOrigin(), result.token, result.expiresAt));
            });
        });
    });
}

// -> GET /api/v1/session/password/reset.html
function passwordResetSite(req, res, next) {
    if (!req.query.reset_token) return next(new HttpError(400, 'Missing reset_token'));

    user.getByResetToken(req.query.reset_token, function (error, user) {
        if (error) return next(new HttpError(401, 'Invalid reset_token'));

        renderTemplate(res, 'password_reset', {
            user: user,
            csrf: req.csrfToken(),
            resetToken: req.query.reset_token,
            title: 'Password Reset'
        });
    });
}

// -> POST /api/v1/session/password/reset
function passwordReset(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.resetToken !== 'string') return next(new HttpError(400, 'Missing resetToken'));
    if (typeof req.body.password !== 'string') return next(new HttpError(400, 'Missing password'));

    debug('passwordReset: with token %s.', req.body.resetToken);

    user.getByResetToken(req.body.resetToken, function (error, userObject) {
        if (error) return next(new HttpError(401, 'Invalid resetToken'));

        if (!userObject.username) return next(new HttpError(401, 'No username set'));

        // setPassword clears the resetToken
        user.setPassword(userObject.id, req.body.password, function (error, result) {
            if (error && error.reason === UserError.BAD_FIELD) return next(new HttpError(406, error.message));
            if (error) return next(new HttpError(500, error));

            res.redirect(util.format('%s?accessToken=%s&expiresAt=%s', config.adminOrigin(), result.token, result.expiresAt));
        });
    });
}


// The callback page takes the redirectURI and the authCode and redirects the browser accordingly
//
// -> GET /api/v1/session/callback
var callback = [
    session.ensureLoggedIn('/api/v1/session/login'),
    function (req, res) {
        renderTemplate(res, 'callback', { callbackServer: req.query.redirectURI });
    }
];


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
var authorization = [
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
            eventlog.add(eventlog.ACTION_USER_LOGIN, auditSource(req, req.oauth2.client.appId), { userId: req.oauth2.user.id, user: user.removePrivateFields(req.oauth2.user) });
            return next();
        }

        apps.get(req.oauth2.client.appId, function (error, appObject) {
            if (error) return sendErrorPageOrRedirect(req, res, 'Invalid request. Unknown app for this client_id.');

            apps.hasAccessTo(appObject, req.oauth2.user, function (error, access) {
                if (error) return sendError(req, res, 'Internal error');
                if (!access) return sendErrorPageOrRedirect(req, res, 'No access to this app.');

                eventlog.add(eventlog.ACTION_USER_LOGIN, auditSource(req, appObject.id, appObject), { userId: req.oauth2.user.id, user: user.removePrivateFields(req.oauth2.user) });

                next();
            });
        });
    },
    gServer.decision({ loadTransaction: false })
];


//  The token endpoint allows an OAuth client to exchange an authcode with an accesstoken.
//
//  Authcodes are obtained using the authorization endpoint. The route is authenticated by
//  providing a Basic auth with clientID as username and clientSecret as password.
//  An authcode is only good for one such exchange to an accesstoken.
//
// -> POST /api/v1/oauth/token
var token = [
    passport.authenticate(['basic', 'oauth2-client-password'], { session: false }),
    gServer.token(),
    gServer.errorHandler()
];

// tests if all requestedScopes are attached to the request
function validateRequestedScopes(req, requestedScopes) {
    assert.strictEqual(typeof req, 'object');
    assert(Array.isArray(requestedScopes));

    if (!req.authInfo || !req.authInfo.scope) return new Error('No scope found');

    var scopes = req.authInfo.scope.split(',');

    // check for roles separately
    if (requestedScopes.indexOf(clients.SCOPE_ROLE_SDK) !== -1 && scopes.indexOf(clients.SCOPE_ROLE_SDK) === -1) {
        return new Error('Missing required scope role "' + clients.SCOPE_ROLE_SDK + '"');
    }

    if (scopes.indexOf('*') !== -1) return null;

    for (var i = 0; i < requestedScopes.length; ++i) {
        if (scopes.indexOf(requestedScopes[i]) === -1) {
            debug('scope: missing scope "%s".', requestedScopes[i]);
            return new Error('Missing required scope "' + requestedScopes[i] + '"');
        }
    }

    return null;
}

//  The scope middleware provides an auth middleware for routes.
//
//  It is used for API routes, which are authenticated using accesstokens.
//  Those accesstokens carry OAuth scopes and the middleware takes the required
//  scope as an argument and will verify the accesstoken against it.
//
//  See server.js:
//    var profileScope = routes.oauth2.scope('profile');
//
function scope(requestedScope) {
    assert.strictEqual(typeof requestedScope, 'string');

    var requestedScopes = requestedScope.split(',');
    debug('scope: add routes with requested scopes', requestedScopes);

    return [
        passport.authenticate(['bearer'], { session: false }),
        function (req, res, next) {
            var error = validateRequestedScopes(req, requestedScopes);
            if (error) return next(new HttpError(401, error.message));

            next();
        }
    ];
}

function websocketAuth(requestedScopes, req, res, next) {
    assert(Array.isArray(requestedScopes));

    if (typeof req.query.access_token !== 'string') return next(new HttpError(401, 'Unauthorized'));

    auth.accessTokenAuth(req.query.access_token, function (error, user, info) {
        if (error) return next(new HttpError(500, error.message));
        if (!user) return next(new HttpError(401, 'Unauthorized'));

        req.user = user;
        req.authInfo = info;

        var e = validateRequestedScopes(req, requestedScopes);
        if (e) return next(new HttpError(401, e.message));

        next();
    });
}

// Cross-site request forgery protection middleware for login form
var csrf = [
    middleware.csrf(),
    function (err, req, res, next) {
        if (err.code !== 'EBADCSRFTOKEN') return next(err);

        sendErrorPageOrRedirect(req, res, 'Form expired');
    }
];

exports = module.exports = {
    loginForm: loginForm,
    login: login,
    logout: logout,
    callback: callback,
    passwordResetRequestSite: passwordResetRequestSite,
    passwordResetRequest: passwordResetRequest,
    passwordSentSite: passwordSentSite,
    passwordResetSite: passwordResetSite,
    passwordReset: passwordReset,
    accountSetupSite: accountSetupSite,
    accountSetup: accountSetup,
    authorization: authorization,
    token: token,
    validateRequestedScopes: validateRequestedScopes,
    scope: scope,
    websocketAuth: websocketAuth,
    csrf: csrf
};
