'use strict';

exports = module.exports = {
    start: start,
    stop: stop
};

var assert = require('assert'),
    config = require('./config.js'),
    debug = require('debug')('box:ldap'),
    http = require('http');

var gServer = null;

function start(callback) {
    assert.strictEqual(typeof callback, 'function');

    function interceptor(req, res) {
        debug(`dockerInterceptor: ${req.method} ${req.url}`);
        return false;
    }

    debug(`startDockerProxy: starting proxy on port ${config.get('dockerProxyPort')}`);

    gServer = http.createServer(function (req, res) {
        if (interceptor(req, res)) return;

        // rejectUnauthorized should not be required but it doesn't work without it
        var options = {
            socketPath: '/var/run/docker.sock',
            method: req.method,
            path: req.url,
            headers: req.headers,
            rejectUnauthorized: false
        };

        var dockerRequest = http.request(options, function (dockerResponse) {
            res.writeHead(dockerResponse.statusCode, dockerResponse.headers);
            dockerResponse.on('error', console.error);
            dockerResponse.pipe(res, { end: true });
        });

        req.on('error', console.error);
        if (!req.readable) {
            dockerRequest.end();
        } else {
            req.pipe(dockerRequest, { end: true });
        }

    }).listen(config.get('dockerProxyPort'), callback);
}

function stop(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (gServer) gServer.close();

    callback();
}