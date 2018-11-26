'use strict';

exports = module.exports = {
    spawn: spawn,
    exec: exec,
    sudo: sudo
};

var assert = require('assert'),
    child_process = require('child_process'),
    debug = require('debug')('box:shell'),
    once = require('once'),
    util = require('util');

var SUDO = '/usr/bin/sudo';

function exec(tag, cmd, callback) {
    assert.strictEqual(typeof tag, 'string');
    assert.strictEqual(typeof cmd, 'string');
    assert.strictEqual(typeof callback, 'function');

    debug(`${tag} exec: ${cmd}`);

    child_process.exec(cmd, function (error, stdout, stderr) {
        debug(`${tag} (stdout): %s`, stdout.toString('utf8'));
        debug(`${tag} (stderr): %s`, stderr.toString('utf8'));

        callback(error);
    });
}

function spawn(tag, file, args, options, callback) {
    assert.strictEqual(typeof tag, 'string');
    assert.strictEqual(typeof file, 'string');
    assert(util.isArray(args));
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    callback = once(callback); // exit may or may not be called after an 'error'

    debug(tag + ' spawn: %s %s', file, args.join(' '));

    if (options.ipc) options.stdio = ['pipe', 'pipe', 'pipe', 'ipc'];

    var cp = child_process.spawn(file, args, options);
    if (options.logStream) {
        cp.stdout.pipe(options.logStream);
        cp.stderr.pipe(options.logStream);
    } else {
        cp.stdout.on('data', function (data) {
            debug(tag + ' (stdout): %s', data.toString('utf8'));
        });

        cp.stderr.on('data', function (data) {
            debug(tag + ' (stdout): %s', data.toString('utf8'));
        });
    }

    cp.on('exit', function (code, signal) {
        if (code || signal) debug(tag + ' code: %s, signal: %s', code, signal);
        if (code === 0) return callback(null);

        var e = new Error(util.format(tag + ' exited with error %s signal %s', code, signal));
        e.code = code;
        e.signal = signal;
        callback(e);
    });

    cp.on('error', function (error) {
        debug(tag + ' code: %s, signal: %s', error.code, error.signal);
        callback(error);
    });

    return cp;
}

function sudo(tag, args, options, callback) {
    assert.strictEqual(typeof tag, 'string');
    assert(util.isArray(args));
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    let sudoArgs = [ '-S' ]; // -S makes sudo read stdin for password
    if (options.preserveEnv) sudoArgs.push('-E'); // -E preserves environment
    if (options.ipc) sudoArgs.push('--close-from=4'); // keep the ipc open. requires closefrom_override in sudoers file

    var cp = spawn(tag, SUDO, sudoArgs.concat(args), options, callback);
    cp.stdin.end();
    return cp;
}
