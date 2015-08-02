#!/usr/bin/env node

'use strict';

// WARNING This is a supervisor eventlistener!
//         The communication happens via stdin/stdout
//         !! No console.log() allowed
//         !! Do not set DEBUG

var supervisor = require('supervisord-eventlistener'),
    safe = require('safetydance'),
    assert = require('assert'),
    exec = require('child_process').exec,
    util = require('util'),
    mailer = require('./src/mailer.js');

var gLastNotifyTime = {};
var gCooldownTime = 1000 * 60  * 5; // 5 min

function collectLogs(program, callback) {
    assert.strictEqual(typeof program, 'string');
    assert.strictEqual(typeof callback, 'function');

    var logFilePath = util.format('/var/log/supervisor/%s.log', program);

    var boxLogData = safe.fs.readFileSync(logFilePath, 'utf-8');
    if (boxLogData === null) return callback(safe.error);
    var boxLogLines = boxLogData.split('\n').slice(-100);

    var dockerLogPath = '/var/log/upstart/docker.log';

    var dockerLogData = safe.fs.readFileSync(dockerLogPath, 'utf-8');
    if (dockerLogData === null) return callback(safe.error);
    var dockerLogLines = dockerLogData.split('\n').slice(-100);

    exec('dmesg', function (error, stdout /*, stderr */) {
        if (error) console.error(error);

        var lines = stdout.split('\n');
        var dmesgLogLines = lines.slice(-100);

        var result = '';
        result += program + '.log\n';
        result += '-------------------------------------\n';
        result += boxLogLines.join('\n');
        result += '\n\n';
        result += 'dmesg\n';
        result += '-------------------------------------\n';
        result += dmesgLogLines.join('\n');
        result += '\n\n';
        result += 'docker\n';
        result += '-------------------------------------\n';
        result += dockerLogLines.join('\n');

        callback(null, result);
    });
}

supervisor.on('PROCESS_STATE_EXITED', function (headers, data) {
    if (data.expected === '1') return console.error('Normal app %s exit', data.processname);

    console.error('%s exited unexpectedly', data.processname);

    collectLogs(data.processname, function (error, result) {
        if (error) {
            console.error('Failed to collect logs.', error);
            result = util.format('Failed to collect logs.', error);
        }

        if (!gLastNotifyTime[data.processname] || gLastNotifyTime[data.processname] < Date.now() - gCooldownTime) {
            console.error('Send mail.');
            mailer.sendCrashNotification(data.processname, result);
            gLastNotifyTime[data.processname] = Date.now();
        } else {
            console.error('Do not send mail, already sent one recently.');
        }
    });
});

mailer.initialize(function () {
    supervisor.listen(process.stdin, process.stdout);
    console.error('Crashnotifier listening...');
});
