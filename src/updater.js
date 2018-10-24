'use strict';

exports = module.exports = {
    updateToLatest: updateToLatest,

    UpdaterError: UpdaterError
};

var assert = require('assert'),
    async = require('async'),
    child_process = require('child_process'),
    backups = require('./backups.js'),
    caas = require('./caas.js'),
    config = require('./config.js'),
    crypto = require('crypto'),
    debug = require('debug')('box:updater'),
    eventlog = require('./eventlog.js'),
    locker = require('./locker.js'),
    mkdirp = require('mkdirp'),
    os = require('os'),
    path = require('path'),
    paths = require('./paths.js'),
    progress = require('./progress.js'),
    safe = require('safetydance'),
    semver = require('semver'),
    shell = require('./shell.js'),
    updateChecker = require('./updatechecker.js'),
    util = require('util'),
    _ = require('underscore');

const RELEASES_PUBLIC_KEY = path.join(__dirname, 'releases.gpg');
const UPDATE_CMD = path.join(__dirname, 'scripts/update.sh');

function UpdaterError(reason, errorOrMessage) {
    assert.strictEqual(typeof reason, 'string');
    assert(errorOrMessage instanceof Error || typeof errorOrMessage === 'string' || typeof errorOrMessage === 'undefined');

    Error.call(this);
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name;
    this.reason = reason;
    if (typeof errorOrMessage === 'undefined') {
        this.message = reason;
    } else if (typeof errorOrMessage === 'string') {
        this.message = errorOrMessage;
    } else {
        this.message = 'Internal error';
        this.nestedError = errorOrMessage;
    }
}
util.inherits(UpdaterError, Error);
UpdaterError.INTERNAL_ERROR = 'Internal Error';
UpdaterError.EXTERNAL_ERROR = 'External Error';
UpdaterError.BAD_STATE = 'Bad state';
UpdaterError.ALREADY_UPTODATE = 'No Update Available';
UpdaterError.NOT_FOUND = 'Not found';
UpdaterError.SELF_UPGRADE_NOT_SUPPORTED = 'Self upgrade not supported';
UpdaterError.NOT_SIGNED = 'Not signed';

function downloadUrl(url, file, callback) {
    assert.strictEqual(typeof file, 'string');
    assert.strictEqual(typeof callback, 'function');

    // do not assert since it comes from the appstore
    if (typeof url !== 'string')  return callback(new UpdaterError(UpdaterError.EXTERNAL_ERROR, `url cannot be download to ${file} as it is not a string`));

    let retryCount = 0;

    safe.fs.unlinkSync(file);

    async.retry({ times: 10, interval: 5000 }, function (retryCallback) {
        debug(`Downloading ${url} to ${file}. Try ${++retryCount}`);

        const args = `-s --fail ${url} -o ${file}`;

        debug(`downloadUrl: curl ${args}`);

        shell.exec('downloadUrl', '/usr/bin/curl', args.split(' '), { }, function (error) {
            if (error) return retryCallback(new UpdaterError(UpdaterError.EXTERNAL_ERROR, `Failed to download ${url}: ${error.message}`));

            debug(`downloadUrl: downloadUrl ${url} to ${file}`);

            retryCallback();
        });
    }, callback);
}

function gpgVerify(file, sig, callback) {
    const cmd = `/usr/bin/gpg --status-fd 1 --no-default-keyring --keyring ${RELEASES_PUBLIC_KEY} --verify ${sig} ${file}`;

    debug(`gpgVerify: ${cmd}`);

    child_process.exec(cmd, { encoding: 'utf8' }, function (error, stdout, stderr) {
        if (error) return callback(new UpdaterError(UpdaterError.NOT_SIGNED, `The signature in ${path.basename(sig)} could not verified`));

        if (stdout.indexOf('[GNUPG:] VALIDSIG 0EADB19CDDA23CD0FE71E3470A372F8703C493CC')) return callback();

        debug(`gpgVerify: verification of ${sig} failed: ${stdout}\n${stderr}`);

        return callback(new UpdaterError(UpdaterError.NOT_SIGNED, `The signature in ${path.basename(sig)} could not verified`));
    });
}

function extractTarball(tarball, dir, callback) {
    const args = `-zxf ${tarball} -C ${dir}`;

    debug(`extractTarball: tar ${args}`);

    shell.exec('extractTarball', '/bin/tar', args.split(' '), { }, function (error) {
        if (error) return callback(new UpdaterError(UpdaterError.EXTERNAL_ERROR, `Failed to extract release package: ${error.message}`));

        safe.fs.unlinkSync(tarball);

        debug(`extractTarball: extracted ${tarball} to ${dir}`);

        callback();
    });
}

function verifyUpdateInfo(versionsFile, updateInfo, callback) {
    assert.strictEqual(typeof versionsFile, 'string');
    assert.strictEqual(typeof updateInfo, 'object');
    assert.strictEqual(typeof callback, 'function');

    var releases = safe.JSON.parse(safe.fs.readFileSync(versionsFile, 'utf8')) || { };
    if (!releases[config.version()] || !releases[config.version()].next) return callback(new UpdaterError(UpdaterError.EXTERNAL_ERROR, 'No version info'));
    var nextVersion = releases[config.version()].next;
    if (typeof releases[nextVersion] !== 'object' || !releases[nextVersion]) return callback(new UpdaterError(UpdaterError.EXTERNAL_ERROR, 'No next version info'));
    if (releases[nextVersion].sourceTarballUrl !== updateInfo.sourceTarballUrl) return callback(new UpdaterError(UpdaterError.EXTERNAL_ERROR, 'Version info mismatch'));

    callback();
}

function downloadAndVerifyRelease(updateInfo, callback) {
    assert.strictEqual(typeof updateInfo, 'object');
    assert.strictEqual(typeof callback, 'function');

    let newBoxSource = path.join(os.tmpdir(), 'box-' + crypto.randomBytes(4).readUInt32LE(0));

    async.series([
        downloadUrl.bind(null, updateInfo.boxVersionsUrl, `${paths.UPDATE_DIR}/versions.json`),
        downloadUrl.bind(null, updateInfo.boxVersionsSigUrl, `${paths.UPDATE_DIR}/versions.json.sig`),
        gpgVerify.bind(null, `${paths.UPDATE_DIR}/versions.json`, `${paths.UPDATE_DIR}/versions.json.sig`),
        verifyUpdateInfo.bind(null, `${paths.UPDATE_DIR}/versions.json`, updateInfo),
        downloadUrl.bind(null, updateInfo.sourceTarballUrl, `${paths.UPDATE_DIR}/box.tar.gz`),
        downloadUrl.bind(null, updateInfo.sourceTarballSigUrl, `${paths.UPDATE_DIR}/box.tar.gz.sig`),
        gpgVerify.bind(null, `${paths.UPDATE_DIR}/box.tar.gz`, `${paths.UPDATE_DIR}/box.tar.gz.sig`),
        mkdirp.bind(null, newBoxSource),
        extractTarball.bind(null, `${paths.UPDATE_DIR}/box.tar.gz`, newBoxSource)
    ], function (error) {
        if (error) return callback(error);

        callback(null, { file: newBoxSource });
    });
}

function doUpdate(boxUpdateInfo, callback) {
    assert(boxUpdateInfo && typeof boxUpdateInfo === 'object');

    function updateError(e) {
        progress.set(progress.UPDATE, -1, e.message);
        callback(e);
    }

    progress.set(progress.UPDATE, 5, 'Downloading and verifying release');

    downloadAndVerifyRelease(boxUpdateInfo, function (error, packageInfo) {
        if (error) return updateError(error);

        progress.set(progress.UPDATE, 10, 'Backing up');

        backups.backupBoxAndApps({ userId: null, username: 'updater' }, function (error) {
            if (error) return updateError(error);

            // NOTE: this data is opaque and will be passed through the installer.sh
            var data= {
                provider: config.provider(),
                apiServerOrigin: config.apiServerOrigin(),
                webServerOrigin: config.webServerOrigin(),
                adminDomain: config.adminDomain(),
                adminFqdn: config.adminFqdn(),
                adminLocation: config.adminLocation(),
                isDemo: config.isDemo(),
                edition: config.edition(),

                appstore: {
                    apiServerOrigin: config.apiServerOrigin()
                },
                caas: {
                    apiServerOrigin: config.apiServerOrigin(),
                    webServerOrigin: config.webServerOrigin()
                },

                version: boxUpdateInfo.version
            };

            debug('updating box %s %j', boxUpdateInfo.sourceTarballUrl, _.omit(data, 'tlsCert', 'tlsKey', 'token', 'appstore', 'caas'));

            progress.set(progress.UPDATE, 70, 'Installing update');

            shell.sudo('update', [ UPDATE_CMD, packageInfo.file, JSON.stringify(data) ], function (error) {
                if (error) return updateError(error);

                // Do not add any code here. The installer script will stop the box code any instant
            });
        });
    });
}

function update(boxUpdateInfo, auditSource, callback) {
    assert.strictEqual(typeof boxUpdateInfo, 'object');
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    if (!boxUpdateInfo) return callback(null);

    var error = locker.lock(locker.OP_BOX_UPDATE);
    if (error) return callback(new UpdaterError(UpdaterError.BAD_STATE, error.message));

    eventlog.add(eventlog.ACTION_UPDATE, auditSource, { boxUpdateInfo: boxUpdateInfo });

    // ensure tools can 'wait' on progress
    progress.set(progress.UPDATE, 0, 'Starting');

    // initiate the update/upgrade but do not wait for it
    if (boxUpdateInfo.upgrade) {
        debug('Starting upgrade');
        caas.upgrade(boxUpdateInfo, function (error) {
            if (error) {
                debug('Upgrade failed with error:', error);
                locker.unlock(locker.OP_BOX_UPDATE);
            }
        });
    } else {
        debug('Starting update');
        doUpdate(boxUpdateInfo, function (error) {
            if (error) {
                debug('Update failed with error:', error);
                locker.unlock(locker.OP_BOX_UPDATE);
            }
        });
    }

    callback(null);
}

function updateToLatest(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    var boxUpdateInfo = updateChecker.getUpdateInfo().box;
    if (!boxUpdateInfo) return callback(new UpdaterError(UpdaterError.ALREADY_UPTODATE, 'No update available'));
    if (!boxUpdateInfo.sourceTarballUrl) return callback(new UpdaterError(UpdaterError.BAD_STATE, 'No automatic update available'));

    if (boxUpdateInfo.upgrade && config.provider() !== 'caas') return callback(new UpdaterError(UpdaterError.SELF_UPGRADE_NOT_SUPPORTED));

    update(boxUpdateInfo, auditSource, callback);
}
