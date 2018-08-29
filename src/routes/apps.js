'use strict';

exports = module.exports = {
    getApp: getApp,
    getApps: getApps,
    getAppIcon: getAppIcon,
    installApp: installApp,
    configureApp: configureApp,
    uninstallApp: uninstallApp,
    restoreApp: restoreApp,
    backupApp: backupApp,
    updateApp: updateApp,
    getLogs: getLogs,
    getLogStream: getLogStream,
    listBackups: listBackups,

    stopApp: stopApp,
    startApp: startApp,
    exec: exec,
    execWebSocket: execWebSocket,

    cloneApp: cloneApp,

    setOwner: setOwner,

    uploadFile: uploadFile,
    downloadFile: downloadFile
};

var apps = require('../apps.js'),
    AppsError = apps.AppsError,
    assert = require('assert'),
    config = require('../config.js'),
    debug = require('debug')('box:routes/apps'),
    fs = require('fs'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    paths = require('../paths.js'),
    safe = require('safetydance'),
    util = require('util'),
    WebSocket = require('ws');

function auditSource(req) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || null;
    return { ip: ip, username: req.user ? req.user.username : null, userId: req.user ? req.user.id : null };
}

function addSpacesSuffix(location, user) {
    if (user.admin || !config.isSpacesEnabled()) return location;

    const spacesSuffix = user.username.replace(/\./g, '-');
    return location === '' ? spacesSuffix : `${location}-${spacesSuffix}`;
}

function getApp(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    apps.get(req.params.id, function (error, app) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, apps.removeInternalFields(app)));
    });
}

function getApps(req, res, next) {
    assert.strictEqual(typeof req.user, 'object');

    apps.getAllByUser(req.user, function (error, allApps) {
        if (error) return next(new HttpError(500, error));

        allApps = allApps.map(apps.removeRestrictedFields);

        next(new HttpSuccess(200, { apps: allApps }));
    });
}

function getAppIcon(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    var iconPath = paths.APP_ICONS_DIR + '/' + req.params.id + '.png';
    fs.exists(iconPath, function (exists) {
        if (!exists) return next(new HttpError(404, 'No such icon'));
        res.sendFile(iconPath);
    });
}

function installApp(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    var data = req.body;
    data.ownerId = req.user.id;

    // atleast one
    if ('manifest' in data && typeof data.manifest !== 'object') return next(new HttpError(400, 'manifest must be an object'));
    if ('appStoreId' in data && typeof data.appStoreId !== 'string') return next(new HttpError(400, 'appStoreId must be a string'));
    if (!data.manifest && !data.appStoreId) return next(new HttpError(400, 'appStoreId or manifest is required'));

    // required
    if (typeof data.location !== 'string') return next(new HttpError(400, 'location is required'));
    data.location = addSpacesSuffix(data.location, req.user);
    if (typeof data.domain !== 'string') return next(new HttpError(400, 'domain is required'));
    if (typeof data.accessRestriction !== 'object') return next(new HttpError(400, 'accessRestriction is required'));

    // optional
    if (('portBindings' in data) && typeof data.portBindings !== 'object') return next(new HttpError(400, 'portBindings must be an object'));
    if ('icon' in data && typeof data.icon !== 'string') return next(new HttpError(400, 'icon is not a string'));

    if (data.backupId && typeof data.backupId !== 'string') return next(new HttpError(400, 'backupId must be string or null'));
    if (data.backupFormat && typeof data.backupFormat !== 'string') return next(new HttpError(400, 'backupFormat must be string or null'));

    // falsy values in cert and key unset the cert
    if (data.key && typeof data.cert !== 'string') return next(new HttpError(400, 'cert must be a string'));
    if (data.cert && typeof data.key !== 'string') return next(new HttpError(400, 'key must be a string'));
    if (data.cert && !data.key) return next(new HttpError(400, 'key must be provided'));
    if (!data.cert && data.key) return next(new HttpError(400, 'cert must be provided'));

    if ('memoryLimit' in data && typeof data.memoryLimit !== 'number') return next(new HttpError(400, 'memoryLimit is not a number'));

    if (data.xFrameOptions && typeof data.xFrameOptions !== 'string') return next(new HttpError(400, 'xFrameOptions must be a string'));

    if ('sso' in data && typeof data.sso !== 'boolean') return next(new HttpError(400, 'sso must be a boolean'));
    if ('enableBackup' in data && typeof data.enableBackup !== 'boolean') return next(new HttpError(400, 'enableBackup must be a boolean'));

    if (('debugMode' in data) && typeof data.debugMode !== 'object') return next(new HttpError(400, 'debugMode must be an object'));

    if (data.robotsTxt && typeof data.robotsTxt !== 'string') return next(new HttpError(400, 'robotsTxt must be a string'));

    debug('Installing app :%j', data);

    apps.install(data, auditSource(req), function (error, app) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error && error.reason === AppsError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error && error.reason === AppsError.PORT_RESERVED) return next(new HttpError(409, 'Port ' + error.message + ' is reserved.'));
        if (error && error.reason === AppsError.PORT_CONFLICT) return next(new HttpError(409, 'Port ' + error.message + ' is already in use.'));
        if (error && error.reason === AppsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === AppsError.BILLING_REQUIRED) return next(new HttpError(402, error.message));
        if (error && error.reason === AppsError.BAD_CERTIFICATE) return next(new HttpError(400, error.message));
        if (error && error.reason === AppsError.EXTERNAL_ERROR) return next(new HttpError(503, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, app));
    });
}

function configureApp(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');
    assert.strictEqual(typeof req.params.id, 'string');

    var data = req.body;

    if ('location' in data && typeof data.location !== 'string') return next(new HttpError(400, 'location must be string'));
    data.location = addSpacesSuffix(data.location, req.user);
    if ('domain' in data && typeof data.domain !== 'string') return next(new HttpError(400, 'domain must be string'));
    if ('portBindings' in data && typeof data.portBindings !== 'object') return next(new HttpError(400, 'portBindings must be an object'));
    if ('accessRestriction' in data && typeof data.accessRestriction !== 'object') return next(new HttpError(400, 'accessRestriction must be an object'));

    // falsy values in cert and key unset the cert
    if (data.key && typeof data.cert !== 'string') return next(new HttpError(400, 'cert must be a string'));
    if (data.cert && typeof data.key !== 'string') return next(new HttpError(400, 'key must be a string'));
    if (data.cert && !data.key) return next(new HttpError(400, 'key must be provided'));
    if (!data.cert && data.key) return next(new HttpError(400, 'cert must be provided'));

    if ('memoryLimit' in data && typeof data.memoryLimit !== 'number') return next(new HttpError(400, 'memoryLimit is not a number'));
    if (data.xFrameOptions && typeof data.xFrameOptions !== 'string') return next(new HttpError(400, 'xFrameOptions must be a string'));

    if ('enableBackup' in data && typeof data.enableBackup !== 'boolean') return next(new HttpError(400, 'enableBackup must be a boolean'));

    if (('debugMode' in data) && typeof data.debugMode !== 'object') return next(new HttpError(400, 'debugMode must be an object'));

    if (data.robotsTxt && typeof data.robotsTxt !== 'string') return next(new HttpError(400, 'robotsTxt must be a string'));

    if ('mailboxName' in data && typeof data.mailboxName !== 'string') return next(new HttpError(400, 'mailboxName must be a string'));

    if ('alternateDomains' in data) {
        if (!Array.isArray(data.alternateDomains)) return next(new HttpError(400, 'alternateDomains must be an array'));
        if (data.alternateDomains.some(function (d) { return (typeof d.domain !== 'string' || typeof d.subdomain !== 'string'); })) return next(new HttpError(400, 'alternateDomains array must contain objects with domain and subdomain strings'));
    }

    debug('Configuring app id:%s data:%j', req.params.id, data);

    apps.configure(req.params.id, data, auditSource(req), function (error) {
        if (error && error.reason === AppsError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error && error.reason === AppsError.PORT_RESERVED) return next(new HttpError(409, 'Port ' + error.message + ' is reserved.'));
        if (error && error.reason === AppsError.PORT_CONFLICT) return next(new HttpError(409, 'Port ' + error.message + ' is already in use.'));
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error && error.reason === AppsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === AppsError.BAD_CERTIFICATE) return next(new HttpError(400, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { }));
    });
}

function restoreApp(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');
    assert.strictEqual(typeof req.params.id, 'string');

    var data = req.body;

    debug('Restore app id:%s', req.params.id);

    if (!('backupId' in req.body)) return next(new HttpError(400, 'backupId is required'));
    if (data.backupId !== null && typeof data.backupId !== 'string') return next(new HttpError(400, 'backupId must be string or null'));

    apps.restore(req.params.id, data, auditSource(req), function (error) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === AppsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error && error.reason === AppsError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { }));
    });
}

function cloneApp(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');
    assert.strictEqual(typeof req.params.id, 'string');

    var data = req.body;
    data.ownerId = req.user.id;

    debug('Clone app id:%s', req.params.id);

    if (typeof data.backupId !== 'string') return next(new HttpError(400, 'backupId must be a string'));
    if (typeof data.location !== 'string') return next(new HttpError(400, 'location is required'));
    data.location = addSpacesSuffix(data.location, req.user);
    if (typeof data.domain !== 'string') return next(new HttpError(400, 'domain is required'));
    if (('portBindings' in data) && typeof data.portBindings !== 'object') return next(new HttpError(400, 'portBindings must be an object'));

    apps.clone(req.params.id, data, auditSource(req), function (error, result) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppsError.PORT_RESERVED) return next(new HttpError(409, 'Port ' + error.message + ' is reserved.'));
        if (error && error.reason === AppsError.PORT_CONFLICT) return next(new HttpError(409, 'Port ' + error.message + ' is already in use.'));
        if (error && error.reason === AppsError.ALREADY_EXISTS) return next(new HttpError(409, error.message));
        if (error && error.reason === AppsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === AppsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error && error.reason === AppsError.BILLING_REQUIRED) return next(new HttpError(402, 'Billing required'));
        if (error && error.reason === AppsError.BAD_CERTIFICATE) return next(new HttpError(400, error.message));
        if (error && error.reason === AppsError.EXTERNAL_ERROR) return next(new HttpError(424, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, { id: result.id }));
    });
}

function backupApp(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    debug('Backup app id:%s', req.params.id);

    apps.backup(req.params.id, function (error) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error && error.reason === AppsError.EXTERNAL_ERROR) return next(new HttpError(503, error));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { }));
    });
}

function uninstallApp(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    debug('Uninstalling app id:%s', req.params.id);

    apps.uninstall(req.params.id, auditSource(req), function (error) {
        if (error && error.reason === AppsError.BILLING_REQUIRED) return next(new HttpError(402, 'Billing required'));
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { }));
    });
}

function startApp(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    debug('Start app id:%s', req.params.id);

    apps.start(req.params.id, function (error) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { }));
    });
}

function stopApp(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    debug('Stop app id:%s', req.params.id);

    apps.stop(req.params.id, function (error) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { }));
    });
}

function updateApp(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');
    assert.strictEqual(typeof req.body, 'object');

    var data = req.body;

    // atleast one
    if ('manifest' in data && typeof data.manifest !== 'object') return next(new HttpError(400, 'manifest must be an object'));
    if ('appStoreId' in data && typeof data.appStoreId !== 'string') return next(new HttpError(400, 'appStoreId must be a string'));
    if (!data.manifest && !data.appStoreId) return next(new HttpError(400, 'appStoreId or manifest is required'));

    if ('icon' in data && typeof data.icon !== 'string') return next(new HttpError(400, 'icon is not a string'));
    if ('force' in data && typeof data.force !== 'boolean') return next(new HttpError(400, 'force must be a boolean'));

    debug('Update app id:%s to manifest:%j', req.params.id, data.manifest);

    apps.update(req.params.id, req.body, auditSource(req), function (error) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppsError.BAD_FIELD) return next(new HttpError(400, error.message));
        if (error && error.reason === AppsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(202, { }));
    });
}

// this route is for streaming logs
function getLogStream(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    debug('Getting logstream of app id:%s', req.params.id);

    var lines = req.query.lines ? parseInt(req.query.lines, 10) : -10; // we ignore last-event-id
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a valid number'));

    function sse(id, data) { return 'id: ' + id + '\ndata: ' + data + '\n\n'; }

    if (req.headers.accept !== 'text/event-stream') return next(new HttpError(400, 'This API call requires EventStream'));

    var options = {
        lines: lines,
        follow: true
    };

    apps.getLogs(req.params.id, options, function (error, logStream) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppsError.BAD_STATE) return next(new HttpError(412, error.message));
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

function getLogs(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    var lines = req.query.lines ? parseInt(req.query.lines, 10) : 100;
    if (isNaN(lines)) return next(new HttpError(400, 'lines must be a number'));

    debug('Getting logs of app id:%s', req.params.id);

    var options = {
        lines: lines,
        follow: false,
        format: req.query.format
    };

    apps.getLogs(req.params.id, options, function (error, logStream) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppsError.BAD_STATE) return next(new HttpError(412, error.message));
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

function demuxStream(stream, stdin) {
    var header = null;

    stream.on('readable', function() {
        header = header || stream.read(4);

        while (header !== null) {
            var length = header.readUInt32BE(0);
            if (length === 0) {
                header = null;
                return stdin.end(); // EOF
            }

            var payload = stream.read(length);

            if (payload === null) break;
            stdin.write(payload);
            header = stream.read(4);
        }
    });
}

function exec(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    debug('Execing into app id:%s and cmd:%s', req.params.id, req.query.cmd);

    var cmd = null;
    if (req.query.cmd) {
        cmd = safe.JSON.parse(req.query.cmd);
        if (!util.isArray(cmd) || cmd.length < 1) return next(new HttpError(400, 'cmd must be array with atleast size 1'));
    }

    var columns = req.query.columns ? parseInt(req.query.columns, 10) : null;
    if (isNaN(columns)) return next(new HttpError(400, 'columns must be a number'));

    var rows = req.query.rows ? parseInt(req.query.rows, 10) : null;
    if (isNaN(rows)) return next(new HttpError(400, 'rows must be a number'));

    var tty = req.query.tty === 'true' ? true : false;

    apps.exec(req.params.id, { cmd: cmd, rows: rows, columns: columns, tty: tty }, function (error, duplexStream) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        if (req.headers['upgrade'] !== 'tcp') return next(new HttpError(404, 'exec requires TCP upgrade'));

        req.clearTimeout();
        res.sendUpgradeHandshake();

        // When tty is disabled, the duplexStream has 2 separate streams. When enabled, it has stdout/stderr merged.
        duplexStream.pipe(res.socket);

        if (tty) {
            res.socket.pipe(duplexStream); // in tty mode, the client always waits for server to exit
        } else {
            demuxStream(res.socket, duplexStream);
            res.socket.on('error', function () { duplexStream.end(); });
            res.socket.on('end', function () { duplexStream.end(); });
        }
    });
}

function execWebSocket(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    debug('Execing websocket into app id:%s and cmd:%s', req.params.id, req.query.cmd);

    var cmd = null;
    if (req.query.cmd) {
        cmd = safe.JSON.parse(req.query.cmd);
        if (!util.isArray(cmd) || cmd.length < 1) return next(new HttpError(400, 'cmd must be array with atleast size 1'));
    }

    var columns = req.query.columns ? parseInt(req.query.columns, 10) : null;
    if (isNaN(columns)) return next(new HttpError(400, 'columns must be a number'));

    var rows = req.query.rows ? parseInt(req.query.rows, 10) : null;
    if (isNaN(rows)) return next(new HttpError(400, 'rows must be a number'));

    var tty = req.query.tty === 'true' ? true : false;

    apps.exec(req.params.id, { cmd: cmd, rows: rows, columns: columns, tty: tty }, function (error, duplexStream) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error && error.reason === AppsError.BAD_STATE) return next(new HttpError(409, error.message));
        if (error) return next(new HttpError(500, error));

        console.log('Connected to terminal');

        req.clearTimeout();

        res.handleUpgrade(function (ws) {
            duplexStream.on('end', function () { ws.close(); });
            duplexStream.on('close', function () { ws.close(); });
            duplexStream.on('error', function (error) {
                console.error('duplexStream error:', error);
            });
            duplexStream.on('data', function (data) {
                if (ws.readyState !== WebSocket.OPEN) return;
                ws.send(data.toString());
            });

            ws.on('error', function (error) {
                console.error('websocket error:', error);
            });
            ws.on('message', function (msg) {
                duplexStream.write(msg);
            });
            ws.on('close', function () {
                // Clean things up, if any?
            });
        });
    });
}

function listBackups(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    var page = typeof req.query.page !== 'undefined' ? parseInt(req.query.page) : 1;
    if (!page || page < 0) return next(new HttpError(400, 'page query param has to be a postive number'));

    var perPage = typeof req.query.per_page !== 'undefined'? parseInt(req.query.per_page) : 25;
    if (!perPage || perPage < 0) return next(new HttpError(400, 'per_page query param has to be a postive number'));

    apps.listBackups(page, perPage, req.params.id, function (error, result) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, 'No such app'));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { backups: result }));
    });
}

function uploadFile(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    debug('uploadFile: %s %j -> %s', req.params.id, req.files, req.query.file);

    if (typeof req.query.file !== 'string' || !req.query.file) return next(new HttpError(400, 'file query argument must be provided'));
    if (!req.files.file) return next(new HttpError(400, 'file must be provided as multipart'));

    apps.uploadFile(req.params.id, req.files.file.path, req.query.file, function (error) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        debug('uploadFile: done');

        next(new HttpSuccess(202, {}));
    });
}

function downloadFile(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');

    debug('downloadFile: ', req.params.id, req.query.file);

    if (typeof req.query.file !== 'string' || !req.query.file) return next(new HttpError(400, 'file query argument must be provided'));

    apps.downloadFile(req.params.id, req.query.file, function (error, stream, info) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        var headers = {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="' + info.filename + '"'
        };
        if (info.size) headers['Content-Length'] = info.size;

        res.writeHead(200, headers);

        stream.pipe(res);
    });
}

function setOwner(req, res, next) {
    assert.strictEqual(typeof req.params.id, 'string');
    assert.strictEqual(typeof req.body, 'object');

    if (typeof req.body.ownerId !== 'string') return next(new HttpError(400, 'ownerId must be a string'));

    apps.setOwner(req.params.id, req.body.ownerId, function (error) {
        if (error && error.reason === AppsError.NOT_FOUND) return next(new HttpError(404, error.message));
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(200, { }));
    });
}
