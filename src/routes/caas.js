'use strict';

exports = module.exports = {
    getConfig: getConfig,
    changePlan: changePlan
};

var caas = require('../caas.js'),
    CaasError = require('../caas.js').CaasError,
    config = require('../config.js'),
    debug = require('debug')('box:routes/cloudron'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    _ = require('underscore');

function getConfig(req, res, next) {
    if (config.provider() !== 'caas') return next(new HttpError(422, 'Cannot use this API with this provider'));

    caas.getBoxAndUserDetails(function (error, result) {
        if (error) return next(new HttpError(500, error));

        // the result is { box: { region, size, plan }, user: { billing, currency } }
        next(new HttpSuccess(200, {
            region: result.box.region,
            size: result.box.size,
            billing: !!result.user.billing,
            plan: result.box.plan,
            currency: result.user.currency
        }));
    });
}

function changePlan(req, res, next) {
    if (config.provider() !== 'caas') return next(new HttpError(422, 'Cannot use this API with this provider'));

    if ('size' in req.body && typeof req.body.size !== 'string') return next(new HttpError(400, 'size must be string'));
    if ('region' in req.body && typeof req.body.region !== 'string') return next(new HttpError(400, 'region must be string'));

    if ('domain' in req.body) {
        if (typeof req.body.domain !== 'string') return next(new HttpError(400, 'domain must be string'));
        if (typeof req.body.provider !== 'string') return next(new HttpError(400, 'provider must be string'));
    }

    if ('zoneName' in req.body && typeof req.body.zoneName !== 'string') return next(new HttpError(400, 'zoneName must be string'));

    debug('Migration requested domain:%s size:%s region:%s', req.body.domain, req.body.size, req.body.region);

    var options = _.pick(req.body, 'domain', 'size', 'region');
    if (Object.keys(options).length === 0) return next(new HttpError(400, 'no migrate option provided'));

    if (options.domain) options.domain = options.domain.toLowerCase();

    caas.changePlan(req.body, function (error) { // pass req.body because 'domain' can have arbitrary options
        if (error && error.reason === CaasError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error && error.reason === CaasError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}
