'use strict';

exports = module.exports = {
    getAll: getAll,
    get: get,
    configure: configure,
    getLogs: getLogs,
    getLogStream: getLogStream,
    restart: restart
};

var addons = require('../addons.js'),
    AddonsError = addons.AddonsError,
    assert = require('assert'),
    debug = require('debug')('box:routes/addons'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function getAll(req, res, next) {
    addons.getServices(function (error, result) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { services: result }));
    });
}

function get(req, res, next) {
    assert.strictEqual(typeof req.params.service, 'string');

    addons.getService(req.params.service, function (error, result) {
        if (error && error.reason === AddonsError.NOT_FOUND) return next(new HttpError(404, 'No such service'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { service: result }));
    });
}

function configure(req, res, next) {
    assert.strictEqual(typeof req.params.service, 'string');

    if (typeof req.body.memory !== 'number') return next(new HttpError(400, 'memory must be a number'));

    const data = {
        memory: req.body.memory,
        memorySwap: req.body.memory * 2
    };

    addons.configureService(req.params.service, data, function (error) {
        if (error && error.reason === AddonsError.NOT_FOUND) return next(new HttpError(404, 'No such service'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}

function getLogs(req, res, next) {
    assert.strictEqual(typeof req.params.service, 'string');

    var lines = req.query.lines ? parseInt(req.query.lines, 10) : 100;
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a number'));

    debug(`Getting logs of service ${req.params.service}`);

    var options = {
        lines: lines,
        follow: false,
        format: req.query.format
    };

    addons.getServiceLogs(req.params.service, options, function (error, logStream) {
        if (error && error.reason === AddonsError.NOT_FOUND) return next(new HttpError(404, 'No such service'));
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
    assert.strictEqual(typeof req.params.service, 'string');

    debug(`Getting logstream of service ${req.params.service}`);

    var lines = req.query.lines ? parseInt(req.query.lines, 10) : -10; // we ignore last-event-id
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a valid number'));

    function sse(id, data) { return 'id: ' + id + '\ndata: ' + data + '\n\n'; }

    if (req.headers.accept !== 'text/event-stream') return next(new HttpError(400, 'This API call requires EventStream'));

    var options = {
        lines: lines,
        follow: true
    };

    addons.getServiceLogs(req.params.service, options, function (error, logStream) {
        if (error && error.reason === AddonsError.NOT_FOUND) return next(new HttpError(404, 'No such service'));
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

function restart(req, res, next) {
    assert.strictEqual(typeof req.params.service, 'string');

    debug(`Restarting service ${req.params.service}`);

    addons.restartService(req.params.service, function (error) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}
