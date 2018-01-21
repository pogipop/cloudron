'use strict';

exports = module.exports = {
    getStatus: getStatus
};

var mail = require('../mail.js'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function getStatus(req, res, next) {
    mail.getStatus(function (error, records) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, records));
    });
}
