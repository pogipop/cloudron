'use strict';

exports = module.exports = {
    getCloudronConfig: getCloudronConfig
};

var cloudron = require('../cloudron.js'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    _ = require('underscore');

function getCloudronConfig(req, res, next) {
    cloudron.getConfig(function (error, cloudronConfig) {
        if (error) return next(new HttpError(500, error));

        var result = _.pick(cloudronConfig, 'apiServerOrigin', 'webServerOrigin', 'fqdn', 'adminFqdn', 'version', 'progress', 'isDemo', 'cloudronName', 'provider');

        next(new HttpSuccess(200, result));
    });
}
