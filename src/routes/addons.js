'use strict';

exports = module.exports = {
    getAll: getAll,
    get: get,
    getLogs: getLogs,
    getLogStream: getLogStream,
    start: start,
    stop: stop
};

var addons = require('../addons.js'),
    AddonsError = addons.AddonsError,
    assert = require('assert'),
    debug = require('debug')('box:routes/addons'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess;

function getAll(req, res, next) {
    addons.getAddons(function (error, result) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { addons: result }));
    });
}

function get(req, res, next) {
    assert.strictEqual(typeof req.params.addon, 'string');

    addons.getStatus(req.params.addon, function (error, result) {
        if (error && error.reason === AddonsError.NOT_FOUND) return next(new HttpError(404, 'No such addon'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { addon: result }));
    });
}

function getLogs(req, res, next) {
    assert.strictEqual(typeof req.params.addon, 'string');

    var lines = req.query.lines ? parseInt(req.query.lines, 10) : 100;
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a number'));

    debug(`Getting logs of addon ${req.params.addon}`);

    var options = {
        lines: lines,
        follow: false,
        format: req.query.format
    };

    addons.getLogs(req.params.addon, options, function (error, logStream) {
        if (error && error.reason === AddonsError.NOT_FOUND) return next(new HttpError(404, 'No such addon'));
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
    assert.strictEqual(typeof req.params.addon, 'string');

    debug(`Getting logstream of addon ${req.params.addon}`);

    var lines = req.query.lines ? parseInt(req.query.lines, 10) : -10; // we ignore last-event-id
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a valid number'));

    function sse(id, data) { return 'id: ' + id + '\ndata: ' + data + '\n\n'; }

    if (req.headers.accept !== 'text/event-stream') return next(new HttpError(400, 'This API call requires EventStream'));

    var options = {
        lines: lines,
        follow: true
    };

    addons.getLogs(req.params.addon, options, function (error, logStream) {
        if (error && error.reason === AddonsError.NOT_FOUND) return next(new HttpError(404, 'No such addon'));
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

function start(req, res, next) {
    assert.strictEqual(typeof req.params.addon, 'string');

    debug(`Starting addon ${req.params.addon}`);

    addons.startAddon(req.params.addon, function (error) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}

function stop(req, res, next) {
    assert.strictEqual(typeof req.params.addon, 'string');

    debug(`Stopping addon ${req.params.addon}`);

    addons.stopAddon(req.params.addon, function (error) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, {}));
    });
}
