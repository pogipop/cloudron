'use strict';

exports = module.exports = {
    resolve: resolve
};

var assert = require('assert'),
    child_process = require('child_process'),
    debug = require('debug')('box:dig');

function resolve(domain, type, options, callback) {
    assert.strictEqual(typeof domain, 'string');
    assert.strictEqual(typeof type, 'string');
    assert.strictEqual(typeof options, 'object');
    assert.strictEqual(typeof callback, 'function');

    // dig @server cloudron.io TXT +short
    var args = [ ];
    if (options.server) args.push('@' + options.server);
    if (type === 'PTR') {
        args.push('-x', domain);
    } else {
        args.push(domain, type);
    }
    args.push('+short');

    child_process.execFile('/usr/bin/dig', args, { encoding: 'utf8', killSignal: 'SIGKILL', timeout: options.timeout || 0 }, function (error, stdout, stderr) {
        if (error && error.killed) error.code = 'ETIMEDOUT';

        if (error || stderr) debug('resolve error (%j): %j %s %s', args, error, stdout, stderr);
        if (error) return callback(error);

        debug('resolve (%j): %s', args, stdout);

        if (!stdout) return callback(); // timeout or no result

        var lines = stdout.trim().split('\n');
        if (type === 'MX') {
            lines = lines.map(function (line) {
                var parts = line.split(' ');
                return { priority: parts[0], exchange: parts[1] };
            });
        }
        return callback(null, lines);
    });
}
