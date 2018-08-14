'use strict';

exports = module.exports = {
    start: start,
    stop: stop
};

var assert = require('assert'),
    bodyParser = require('body-parser'),
    config = require('./config.js'),
    debug = require('debug')('box:dockerproxy'),
    http = require('http'),
    net = require('net');

var gServer = null;
var gJSONParser = bodyParser.json();

function start(callback) {
    assert.strictEqual(typeof callback, 'function');


    function authorized(req, res) {
        // TODO add here some authorization
        // - block apps not using the docker addon
        // - block calls regarding platform containers
        // - only allow managing and inspection of containers belonging to the app

        return true;
    }

    debug(`startDockerProxy: starting proxy on port ${config.get('dockerProxyPort')}`);

    gServer = http.createServer(function (req, res) {
        if (!authorized(req, res)) return;

        var options = {
            socketPath: '/var/run/docker.sock',
            method: req.method,
            path: req.url,
            headers: req.headers
        };

        var dockerRequest = http.request(options, function (dockerResponse) {
            res.writeHead(dockerResponse.statusCode, dockerResponse.headers);

            // Force node to send out the headers, this is required for the /container/wait api to make the docker cli proceed
            res.write(' ');

            dockerResponse.on('error', function (error) { console.error('dockerResponse error:', error); });
            dockerResponse.pipe(res, { end: true });
        });

        req.on('error', function (error) { console.error('req error:', error); });

        if (req.method === 'POST' && req.url.match(/\/containers\/create/)) {
            gJSONParser(req, res, function () {
                // overwrite the network the container lives in
                req.body.HostConfig.NetworkMode = 'cloudron';

                var plainBody = JSON.stringify(req.body);

                dockerRequest.setHeader('Content-Length', Buffer.byteLength(plainBody));
                dockerRequest.end(plainBody);
            });
        } else if (!req.readable) {
            dockerRequest.end();
        } else {
            req.pipe(dockerRequest, { end: true });
        }
    }).listen(config.get('dockerProxyPort'), callback);

    gServer.on('upgrade', function (req, client, head) {
        // Create a new tcp connection to the TCP server
        var remote = net.connect('/var/run/docker.sock', function () {
            // two-way pipes between client and docker daemon
            client.pipe(remote).pipe(client);

            // resend the upgrade event to the docker daemon, so it responds with the proper message through the pipes
            remote.write(req.method + ' ' + req.url + ' HTTP/1.1\r\n' +
                `Host: ${req.headers.host}\r\n` +
                'Connection: Upgrade\r\n' +
                'Upgrade: tcp\r\n' +
                '\r\n'
            );
        });
    });
}

function stop(callback) {
    assert.strictEqual(typeof callback, 'function');

    if (gServer) gServer.close();

    callback();
}