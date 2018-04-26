'use strict';

exports = module.exports = {
    login: login
};

var developer = require('../developer.js'),
    passport = require('passport'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    speakeasy = require('speakeasy');

function login(req, res, next) {
    passport.authenticate('local', function (error, user) {
        if (error) return next(new HttpError(500, error));
        if (!user) return next(new HttpError(401, 'Invalid credentials'));

        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;

        if (user.twoFactorAuthenticationEnabled) {
            if (!req.body.totpToken) return next(new HttpError(401, 'A totpToken must be provided'));

            let verified = speakeasy.totp.verify({ secret: user.twoFactorAuthenticationSecret, encoding: 'base32', token: req.body.totpToken });
            if (!verified) return next(new HttpError(401, 'Invalid totpToken'));
        }

        developer.issueDeveloperToken(user, ip, function (error, result) {
            if (error) return next(new HttpError(500, error));

            next(new HttpSuccess(200, { token: result.token, expiresAt: result.expiresAt }));
        });
  })(req, res, next);
}

