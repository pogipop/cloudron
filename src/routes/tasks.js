'use strict';

exports = module.exports = {
    get: get,
    stopTask: stopTask,
    list: list,

    getLogs: getLogs,
    getLogStream: getLogStream
};

let assert = require('assert'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    TaskError = require('../tasks.js').TaskError,
    tasks = require('../tasks.js');

function stopTask(req, res, next) {
    assert.strictEqual(typeof req.params.taskId, 'string');

    tasks.stopTask(req.params.taskId, function (error) {
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

        next(new HttpSuccess(200, tasks.removePrivateFields(task)));
    });
}

function list(req, res, next) {
    var page = typeof req.query.page !== 'undefined' ? parseInt(req.query.page) : 1;
    if (!page || page < 0) return next(new HttpError(400, 'page query param has to be a postive number'));

    var perPage = typeof req.query.per_page !== 'undefined'? parseInt(req.query.per_page) : 25;
    if (!perPage || perPage < 0) return next(new HttpError(400, 'per_page query param has to be a postive number'));

    if (req.query.type && typeof req.query.type !== 'string') return next(new HttpError(400, 'type must be a string'));

    tasks.listByTypePaged(req.query.type || null, page, perPage, function (error, result) {
        if (error) return next(new HttpError(500, error));

        result = result.map(tasks.removePrivateFields);

        next(new HttpSuccess(200, { tasks: result }));
    });
}

function getLogs(req, res, next) {
    assert.strictEqual(typeof req.params.taskId, 'string');

    var lines = req.query.lines ? parseInt(req.query.lines, 10) : 100;
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a number'));

    var options = {
        lines: lines,
        follow: false,
        format: req.query.format
    };

    tasks.getLogs(req.params.taskId, options, function (error, logStream) {
        if (error && error.reason === TaskError.NOT_FOUND) return next(new HttpError(404, 'No such task'));
        if (error) return next(new HttpError(500, error));

        res.writeHead(200, {
            'Content-Type': 'application/x-logs',
            'Content-Disposition': 'attachment; filename="log.txt"',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no' // disable nginx buffering
        });
        logStream.pipe(res);
    });
}

// this route is for streaming logs
function getLogStream(req, res, next) {
    assert.strictEqual(typeof req.params.taskId, 'string');

    var lines = req.query.lines ? parseInt(req.query.lines, 10) : -10; // we ignore last-event-id
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a valid number'));

    function sse(id, data) { return 'id: ' + id + '\ndata: ' + data + '\n\n'; }

    if (req.headers.accept !== 'text/event-stream') return next(new HttpError(400, 'This API call requires EventStream'));

    var options = {
        lines: lines,
        follow: true
    };

    tasks.getLogs(req.params.taskId, options, function (error, logStream) {
        if (error && error.reason === TaskError.NOT_FOUND) return next(new HttpError(404, 'No such task'));
        if (error) return next(new HttpError(500, error));

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no', // disable nginx buffering
            'Access-Control-Allow-Origin': '*'
        });
        res.write('retry: 3000\n');
        res.on('close', logStream.close);
        logStream.on('data', function (data) {
            var obj = JSON.parse(data);
            res.write(sse(obj.monotonicTimestamp, JSON.stringify(obj))); // send timestamp as id
        });
        logStream.on('end', res.end.bind(res));
        logStream.on('error', res.end.bind(res, null));
    });
}
