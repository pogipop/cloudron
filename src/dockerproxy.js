'use strict';

exports = module.exports = {
    start: start,
    stop: stop
};

var assert = require('assert'),
    config = require('./config.js'),
    express = require('express'),
    debug = require('debug')('box:dockerproxy'),
    http = require('http'),
    middleware = require('./middleware'),
    net = require('net');

var gHttpServer = null;

function authorizeApp(req, res, next) {
    // TODO add here some authorization
    // - block apps not using the docker addon
    // - block calls regarding platform containers
    // - only allow managing and inspection of containers belonging to the app

    return next();
}

function attachDockerRequest(req, res, next) {
    var options = {
        socketPath: '/var/run/docker.sock',
        method: req.method,
        path: req.url,
        headers: req.headers
    };

    req.dockerRequest = http.request(options, function (dockerResponse) {
        res.writeHead(dockerResponse.statusCode, dockerResponse.headers);

        // Force node to send out the headers, this is required for the /container/wait api to make the docker cli proceed
        res.write(' ');

        dockerResponse.on('error', function (error) { console.error('dockerResponse error:', error); });
        dockerResponse.pipe(res, { end: true });
    });

    next();
}

function containersCreate(req, res, next) {
    // overwrite the network the container lives in
    req.body.HostConfig.NetworkMode = 'cloudron';

    var plainBody = JSON.stringify(req.body);

    req.dockerRequest.setHeader('Content-Length', Buffer.byteLength(plainBody));
    req.dockerRequest.end(plainBody);
}

function process(req, res, next) {
    if (!req.readable) {
        req.dockerRequest.end();
    } else {
        req.pipe(req.dockerRequest, { end: true });
    }
}

function start(callback) {
    assert.strictEqual(typeof callback, 'function');
    assert(gHttpServer === null, 'Already started');

    let json = middleware.json({ strict: true });
    let router = new express.Router();
    router.post('/:version/containers/create', json, containersCreate);    // only available until no-domain

    var proxyServer = express();
    proxyServer.use(authorizeApp)
        .use(attachDockerRequest)
        .use(router)
        .use(process);

    gHttpServer = http.createServer(proxyServer);
    gHttpServer.listen(config.get('dockerProxyPort'), callback);

    debug(`startDockerProxy: started proxy on port ${config.get('dockerProxyPort')}`);

    gHttpServer.on('upgrade', function (req, client, head) {
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

    if (gHttpServer) gHttpServer.close();

    gHttpServer = null;

    callback();
}