'use strict';

exports = module.exports = {
    connection: connectionInstance(),
    downloadImage: downloadImage,
    createContainer: createContainer,
    startContainer: startContainer,
    stopContainer: stopContainer,
    stopContainerByName: stopContainer,
    stopContainers: stopContainers,
    deleteContainer: deleteContainer,
    deleteContainerByName: deleteContainer,
    deleteImage: deleteImage,
    deleteContainers: deleteContainers,
    createSubcontainer: createSubcontainer,
    getContainerIdByIp: getContainerIdByIp,
    inspect: inspect,
    inspectByName: inspect,
    execContainer: execContainer
};

function connectionInstance() {
    var Docker = require('dockerode');
    var docker;

    if (process.env.BOX_ENV === 'test') {
        // test code runs a docker proxy on this port
        docker = new Docker({ host: 'http://localhost', port: 5687 });

        // proxy code uses this to route to the real docker
        docker.options = { socketPath: '/var/run/docker.sock' };
    } else {
        docker = new Docker({ socketPath: '/var/run/docker.sock' });
    }

    return docker;
}

var addons = require('./addons.js'),
    async = require('async'),
    assert = require('assert'),
    child_process = require('child_process'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    debug = require('debug')('box:docker.js'),
    once = require('once'),
    safe = require('safetydance'),
    shell = require('./shell.js'),
    spawn = child_process.spawn,
    util = require('util'),
    _ = require('underscore');

function debugApp(app, args) {
    assert(typeof app === 'object');

    debug(app.fqdn + ' ' + util.format.apply(util, Array.prototype.slice.call(arguments, 1)));
}

function pullImage(manifest, callback) {
    var docker = exports.connection;

    // Use docker CLI here to support downloading of private repos. for dockerode, we have to use
    // https://github.com/apocas/dockerode#pull-from-private-repos
    shell.exec('pullImage', '/usr/bin/docker', [ 'pull', manifest.dockerImage ], { }, function (error) {
        if (error) {
            debug(`pullImage: Error pulling image ${manifest.dockerImage} of ${manifest.id}: ${error.message}`);
            return callback(new Error('Failed to pull image'));
        }

        var image = docker.getImage(manifest.dockerImage);

        image.inspect(function (err, data) {
            if (err) return callback(new Error('Error inspecting image:' + err.message));
            if (!data || !data.Config) return callback(new Error('Missing Config in image:' + JSON.stringify(data, null, 4)));
            if (!data.Config.Entrypoint && !data.Config.Cmd) return callback(new Error('Only images with entry point are allowed'));

            if (data.Config.ExposedPorts) debug('This image of %s exposes ports: %j', manifest.id, data.Config.ExposedPorts);

            callback(null);
        });
    });
}

function downloadImage(manifest, callback) {
    assert.strictEqual(typeof manifest, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('downloadImage %s %s', manifest.id, manifest.dockerImage);

    var attempt = 1;

    async.retry({ times: 10, interval: 15000 }, function (retryCallback) {
        debug('Downloading image %s %s. attempt: %s', manifest.id, manifest.dockerImage, attempt++);

        pullImage(manifest, function (error) {
            if (error) console.error(error);

            retryCallback(error);
        });
    }, callback);
}

function createSubcontainer(app, name, cmd, options, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof name, 'string');
    assert(!cmd || util.isArray(cmd));
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    var docker = exports.connection,
        isAppContainer = !cmd; // non app-containers are like scheduler containers

    var manifest = app.manifest;
    var exposedPorts = {}, dockerPortBindings = { };
    var domain = app.fqdn;
    var stdEnv = [
        'CLOUDRON=1',
        'WEBADMIN_ORIGIN=' + config.adminOrigin(),
        'API_ORIGIN=' + config.adminOrigin(),
        'APP_ORIGIN=https://' + domain,
        'APP_DOMAIN=' + domain
    ];

    // docker portBindings requires ports to be exposed
    exposedPorts[manifest.httpPort + '/tcp'] = {};

    dockerPortBindings[manifest.httpPort + '/tcp'] = [ { HostIp: '127.0.0.1', HostPort: app.httpPort + '' } ];

    var portEnv = [];
    for (let portName in app.portBindings) {
        const hostPort = app.portBindings[portName];
        const portType = portName in manifest.tcpPorts ? 'tcp' : 'udp';
        const ports = portType == 'tcp' ? manifest.tcpPorts : manifest.udpPorts;

        var containerPort = ports[portName].containerPort || hostPort;

        exposedPorts[`${containerPort}/${portType}`] = {};
        portEnv.push(`${portName}=${hostPort}`);

        dockerPortBindings[`${containerPort}/${portType}`] = [ { HostIp: '0.0.0.0', HostPort: hostPort + '' } ];
    }

    // first check db record, then manifest
    var memoryLimit = app.memoryLimit || manifest.memoryLimit || 0;

    if (memoryLimit === -1) { // unrestricted
        memoryLimit = 0;
    } else if (memoryLimit === 0 || memoryLimit < constants.DEFAULT_MEMORY_LIMIT) { // ensure we never go below minimum (in case we change the default)
        memoryLimit = constants.DEFAULT_MEMORY_LIMIT;
    }

    // give scheduler tasks twice the memory limit since background jobs take more memory
    // if required, we can make this a manifest and runtime argument later
    if (!isAppContainer) memoryLimit *= 2;

    // apparmor is disabled on few servers
    var enableSecurityOpt = config.CLOUDRON && safe(function () { return child_process.spawnSync('aa-enabled').status === 0; }, false);

    addons.getEnvironment(app, function (error, addonEnv) {
        if (error) return callback(new Error('Error getting addon environment : ' + error));

        // do no set hostname of containers to location as it might conflict with addons names. for example, an app installed in mail
        // location may not reach mail container anymore by DNS. We cannot set hostname to fqdn either as that sets up the dns
        // name to look up the internal docker ip. this makes curl from within container fail
        // Note that Hostname has no effect on DNS. We have to use the --net-alias for dns.
        // Hostname cannot be set with container NetworkMode
        var containerOptions = {
            name: name, // used for filtering logs
            Tty: isAppContainer,
            Image: app.manifest.dockerImage,
            Cmd: (isAppContainer && app.debugMode && app.debugMode.cmd) ? app.debugMode.cmd : cmd,
            Env: stdEnv.concat(addonEnv).concat(portEnv),
            ExposedPorts: isAppContainer ? exposedPorts : { },
            Volumes: { // see also ReadonlyRootfs
                '/tmp': {},
                '/run': {}
            },
            Labels: {
                'fqdn': app.fqdn,
                'appId': app.id,
                'isSubcontainer': String(!isAppContainer)
            },
            HostConfig: {
                Binds: addons.getBindsSync(app, app.manifest.addons),
                LogConfig: {
                    Type: 'syslog',
                    Config: {
                        'tag': app.id,
                        'syslog-address': 'udp://127.0.0.1:2514', // see apps.js:validatePortBindings()
                        'syslog-format': 'rfc5424'
                    }
                },
                Memory: memoryLimit / 2,
                MemorySwap: memoryLimit, // Memory + Swap
                PortBindings: isAppContainer ? dockerPortBindings : { },
                PublishAllPorts: false,
                ReadonlyRootfs: app.debugMode ? !!app.debugMode.readonlyRootfs : true,
                RestartPolicy: {
                    'Name': isAppContainer ? 'always' : 'no',
                    'MaximumRetryCount': 0
                },
                CpuShares: 512, // relative to 1024 for system processes
                VolumesFrom: isAppContainer ? null : [ app.containerId + ':rw' ],
                NetworkMode: 'cloudron',
                Dns: ['172.18.0.1'], // use internal dns
                DnsSearch: ['.'], // use internal dns
                SecurityOpt: enableSecurityOpt ? [ 'apparmor=docker-cloudron-app' ] : null // profile available only on cloudron
            }
        };

        var capabilities = manifest.capabilities || [];
        if (capabilities.includes('net_admin')) {
            containerOptions.HostConfig.CapAdd = [
                'NET_ADMIN'
            ];
        }

        containerOptions = _.extend(containerOptions, options);

        debugApp(app, 'Creating container for %s', app.manifest.dockerImage);

        docker.createContainer(containerOptions, callback);
    });
}

function createContainer(app, callback) {
    createSubcontainer(app, app.id /* name */, null /* cmd */, { } /* options */, callback);
}

function startContainer(containerId, callback) {
    assert.strictEqual(typeof containerId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var docker = exports.connection;

    var container = docker.getContainer(containerId);
    debug('Starting container %s', containerId);

    container.start(function (error) {
        if (error && error.statusCode !== 304) return callback(new Error('Error starting container :' + error));

        return callback(null);
    });
}

function stopContainer(containerId, callback) {
    assert(!containerId || typeof containerId === 'string');
    assert.strictEqual(typeof callback, 'function');

    if (!containerId) {
        debug('No previous container to stop');
        return callback();
    }

    var docker = exports.connection;
    var container = docker.getContainer(containerId);
    debug('Stopping container %s', containerId);

    var options = {
        t: 10 // wait for 10 seconds before killing it
    };

    container.stop(options, function (error) {
        if (error && (error.statusCode !== 304 && error.statusCode !== 404)) return callback(new Error('Error stopping container:' + error));

        debug('Waiting for container ' + containerId);

        container.wait(function (error, data) {
            if (error && (error.statusCode !== 304 && error.statusCode !== 404)) return callback(new Error('Error waiting on container:' + error));

            debug('Container %s stopped with status code [%s]', containerId, data ? String(data.StatusCode) : '');

            return callback(null);
        });
    });
}

function deleteContainer(containerId, callback) {
    assert(!containerId || typeof containerId === 'string');
    assert.strictEqual(typeof callback, 'function');

    debug('deleting container %s', containerId);

    if (containerId === null) return callback(null);

    var docker = exports.connection;
    var container = docker.getContainer(containerId);

    var removeOptions = {
        force: true, // kill container if it's running
        v: true // removes volumes associated with the container (but not host mounts)
    };

    container.remove(removeOptions, function (error) {
        if (error && error.statusCode === 404) return callback(null);

        if (error) debug('Error removing container %s : %j', containerId, error);

        callback(error);
    });
}

function deleteContainers(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var docker = exports.connection;

    debug('deleting containers of %s', appId);

    docker.listContainers({ all: 1, filters: JSON.stringify({ label: [ 'appId=' + appId ] }) }, function (error, containers) {
        if (error) return callback(error);

        async.eachSeries(containers, function (container, iteratorDone) {
            deleteContainer(container.Id, iteratorDone);
        }, callback);
    });
}

function stopContainers(appId, callback) {
    assert.strictEqual(typeof appId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var docker = exports.connection;

    debug('stopping containers of %s', appId);

    docker.listContainers({ all: 1, filters: JSON.stringify({ label: [ 'appId=' + appId ] }) }, function (error, containers) {
        if (error) return callback(error);

        async.eachSeries(containers, function (container, iteratorDone) {
            stopContainer(container.Id, iteratorDone);
        }, callback);
    });
}

function deleteImage(manifest, callback) {
    assert(!manifest || typeof manifest === 'object');
    assert.strictEqual(typeof callback, 'function');

    var dockerImage = manifest ? manifest.dockerImage : null;
    if (!dockerImage) return callback(null);

    var docker = exports.connection;

    var removeOptions = {
        force: false, // might be shared with another instance of this app
        noprune: false // delete untagged parents
    };

    // registry v1 used to pull down all *tags*. this meant that deleting image by tag was not enough (since that
    // just removes the tag). we used to remove the image by id. this is not required anymore because aliases are
    // not created anymore after https://github.com/docker/docker/pull/10571
    docker.getImage(dockerImage).remove(removeOptions, function (error) {
        if (error && error.statusCode === 404) return callback(null);
        if (error && error.statusCode === 409) return callback(null); // another container using the image

        if (error) debug('Error removing image %s : %j', dockerImage, error);

        callback(error);
    });
}

function getContainerIdByIp(ip, callback) {
    assert.strictEqual(typeof ip, 'string');
    assert.strictEqual(typeof callback, 'function');

    var docker = exports.connection;

    docker.getNetwork('cloudron').inspect(function (error, bridge) {
        if (error && error.statusCode === 404) return callback(new Error('Unable to find the cloudron network'));
        if (error) return callback(error);

        var containerId;
        for (var id in bridge.Containers) {
            if (bridge.Containers[id].IPv4Address.indexOf(ip + '/16') === 0) {
                containerId = id;
                break;
            }
        }
        if (!containerId) return callback(new Error('No container with that ip'));

        callback(null, containerId);
    });
}

function inspect(containerId, callback) {
    assert.strictEqual(typeof containerId, 'string');
    assert.strictEqual(typeof callback, 'function');

    var container = exports.connection.getContainer(containerId);

    container.inspect(function (error, result) {
        if (error) return callback(error);
        callback(null, result);
    });
}

function execContainer(containerId, cmd, options, callback) {
    assert.strictEqual(typeof containerId, 'string');
    assert(util.isArray(cmd));
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback); // ChildProcess exit may or may not be called after error

    var cp = spawn('/usr/bin/docker', [ 'exec', '-i', containerId  ].concat(cmd));

    var chunks = [ ];

    if (options.stdout) {
        cp.stdout.pipe(options.stdout);
    } else if (options.bufferStdout) {
        cp.stdout.on('data', function (chunk) { chunks.push(chunk); });
    } else {
        cp.stdout.pipe(process.stdout);
    }

    cp.on('error', callback);
    cp.on('exit', function (code, signal) {
        debug('execContainer code: %s signal: %s', code, signal);
        if (!callback.called) callback(code ? 'Failed with status ' + code : null, Buffer.concat(chunks));
    });

    cp.stderr.pipe(options.stderr || process.stderr);

    if (options.stdin) options.stdin.pipe(cp.stdin).on('error', callback);
}
