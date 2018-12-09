'use strict';

exports = module.exports = {
    get: get,
    stopTask: stopTask,
    list: list
};

let assert = require('assert'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    TaskError = require('../tasks.js').TaskError,
    tasks = require('../tasks.js');

function auditSource(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
}

function stopTask(req, res, next) {
    assert.strictEqual(typeof req.params.taskId, 'string');

    tasks.stopTask(req.params.taskId, auditSource(req), function (error) {
        if (error && error.reason === TaskError.NOT_FOUND) return next(new HttpError(404, 'No such task'));
        if (error && error.reason === TaskError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(204, {}));
    });
}

function get(req, res, next) {
    assert.strictEqual(typeof req.params.taskId, 'string');

    tasks.get(req.params.taskId, function (error, task) {
        if (error && error.reason === TaskError.NOT_FOUND) return next(new HttpError(404, 'No such task'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, task));
    });
}

function list(req, res, next) {
    var page = typeof req.query.page !== 'undefined' ? parseInt(req.query.page) : 1;
    if (!page || page < 0) return next(new HttpError(400, 'page query param has to be a postive number'));

    var perPage = typeof req.query.per_page !== 'undefined'? parseInt(req.query.per_page) : 25;
    if (!perPage || perPage < 0) return next(new HttpError(400, 'per_page query param has to be a postive number'));

    if (req.query.type && typeof req.query.type !== 'string') return next(new HttpError(400, 'type must be a string'));

    tasks.listPaged(req.query.type || null, page, perPage, function (error, tasks) {
        if (error && error.reason === TaskError.NOT_FOUND) return next(new HttpError(404, 'No such task'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { tasks }));
    });
}
