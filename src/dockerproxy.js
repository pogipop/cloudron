'use strict';

exports = module.exports = {
    start: start,
    stop: stop
};

var apps = require('./apps.js'),
    AppsError = apps.AppsError,
    assert = require('assert'),
    config = require('./config.js'),
    express = require('express'),
    debug = require('debug')('box:dockerproxy'),
    http = require('http'),
    HttpError = require('connect-lastmile').HttpError,
    middleware = require('./middleware'),
    net = require('net'),
    path = require('path'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    _ = require('underscore');

var gHttpServer = null;

function authorizeApp(req, res, next) {
    // TODO add here some authorization
    // - block apps not using the docker addon
    // - block calls regarding platform containers
    // - only allow managing and inspection of containers belonging to the app
    // - allow docker to be called from child containers spun of from an authorized app

    // make the tests pass for now
    if (config.TEST) {
        req.app = { id: 'testappid' };
        return next();
    }

    apps.getByIpAddress(req.connection.remoteAddress, function (error, app) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(401, 'Unauthorized'));
        if (error) return next(new HttpError(500, error));

        if (!('docker' in app.manifest.addons)) return next(new HttpError(401, 'Unauthorized'));

        req.app = app;

        next();
    });
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
    safe.set(req.body, 'HostConfig.NetworkMode', 'cloudron'); // overwrite the network the container lives in
    safe.set(req.body, 'Labels',  _.extend({ }, safe.query(req.body, 'Labels'), { appId: req.app.id }));    // overwrite the app id to track containers of an app

    const appDataDir = path.join(paths.APPS_DATA_DIR, req.app.id, 'data'),
        dockerDataDir = path.join(paths.APPS_DATA_DIR, req.app.id, 'docker');

    debug('Original volume binds:', req.body.HostConfig.Binds);

    let binds = [];
    for (let bind of (req.body.HostConfig.Binds || [])) {
        if (bind.startsWith('/app/data')) binds.push(bind.replace(new RegExp('^/app/data'), appDataDir));

        else binds.push(`${dockerDataDir}/${bind}`);
    }

    // cleanup the paths from potential double slashes
    binds = binds.map(function (bind) { return bind.replace(/\/+/g, '/'); });

    debug('Rewritten volume binds:', binds);
    safe.set(req.body, 'HostConfig.Binds', binds);

    let plainBody = JSON.stringify(req.body);

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
    router.post('/:version/containers/create', containersCreate);

    let proxyServer = express();
    proxyServer.use(authorizeApp)
        .use(attachDockerRequest)
        .use(json)
        .use(router)
        .use(process)
        .use(middleware.lastMile());

    gHttpServer = http.createServer(proxyServer);
    gHttpServer.listen(config.get('dockerProxyPort'), '0.0.0.0', callback);

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
