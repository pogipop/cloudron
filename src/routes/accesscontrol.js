'use strict';

exports = module.exports = {
    scope: scope,
    websocketAuth: websocketAuth
};

var accesscontrol = require('../accesscontrol.js'),
    assert = require('assert'),
    auth = require('../auth.js'),
    debug = require('debug')('box:routes/accesscontrol'),
    HttpError = require('connect-lastmile').HttpError,
    passport = require('passport');

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
            var error = accesscontrol.validateRequestedScopes(req.authInfo || null, requestedScopes);
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

        var e = accesscontrol.validateRequestedScopes(req.authInfo, requestedScopes);
        if (e) return next(new HttpError(401, e.message));

        next();
    });
}
